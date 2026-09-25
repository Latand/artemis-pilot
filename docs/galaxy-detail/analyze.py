"""Compare matched production/reference captures, without exposure normalization.

Usage: python docs/galaxy-detail/analyze.py BEFORE AFTER REFERENCE OUTPUT
BEFORE/AFTER contain detail/report.json. REFERENCE is one complete artifact or a
parent directory holding all three galaxy-detail-reference-* shard artifacts.
Dependencies (analysis only): numpy, scipy, Pillow.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter


def parts(root: Path) -> list[Path]:
    if (root / "detail/report.json").exists():
        return [root]
    found = sorted(p.parent.parent for p in root.glob("galaxy-detail-reference-*/detail/report.json"))
    assert found, f"No reference shards in {root}"
    return found


def load(root: Path) -> tuple[dict, dict[str, dict]]:
    reports = [json.loads((p / "detail/report.json").read_text()) for p in parts(root)]
    frames: dict[str, dict] = {}
    for report in reports:
        assert report.get("completed") is True, f"Incomplete capture in {root}"
        assert not report["errors"], f"Browser errors in {root}"
        assert report["checks"] and all(c["pass"] for c in report["checks"]), root
        for key in ("variant", "epochSeconds", "exposure", "viewport", "dpr", "gpu"):
            assert report[key] == reports[0][key], f"Shard metadata mismatch: {key}"
        for frame in report["frames"]:
            if frame["name"] in frames:
                old = frames[frame["name"]]
                assert frame["state"] == old["state"] and frame["pose"] == old["pose"], "Duplicate pose mismatch"
            else:
                frames[frame["name"]] = frame
    if len(reports) > 1:
        assert {r["referenceShard"] for r in reports} == {"static", "early", "late"}, "Missing reference shard"
    report = dict(reports[0])
    report["frames"] = list(frames.values())
    if len(reports) > 1:
        report["timingMethod"] += " Reference timings span three independent shard runners."
        report["motionReadbackTiming"] = None
    return report, frames


def image(root: Path, name: str) -> np.ndarray:
    paths = [p / "detail" / f"{name}.png" for p in parts(root) if (p / "detail" / f"{name}.png").exists()]
    assert paths, (root, name)
    arrays = [np.asarray(Image.open(p).convert("RGB"), dtype=np.float64) for p in paths]
    assert all(np.array_equal(a, arrays[0]) for a in arrays), f"Duplicate shard image differs: {name}"
    return arrays[0]


def luma(rgb: np.ndarray) -> np.ndarray:
    return rgb @ np.array([0.2126, 0.7152, 0.0722])


def correlation(a: np.ndarray, b: np.ndarray) -> float | None:
    x, y = a.ravel() - a.mean(), b.ravel() - b.mean()
    norm = float(np.linalg.norm(x) * np.linalg.norm(y))
    return float(x @ y / norm) if norm > 1e-12 else None


def measures(rgb: np.ndarray, ref: np.ndarray) -> dict:
    y, yr = luma(rgb), luma(ref)
    high = y - gaussian_filter(y, 2.0)
    high_ref = yr - gaussian_filter(yr, 2.0)
    # Fixed central crop, selected by geometry, not by the observed improvement.
    h, w = y.shape
    roi = np.s_[h // 6:5 * h // 6, w // 8:7 * w // 8]
    return {
        "rgb_mae": float(np.abs(rgb - ref).mean()),
        "luma_rmse": float(np.sqrt(np.square(y - yr).mean())),
        "highpass_correlation": correlation(high, high_ref),
        "highpass_rmse": float(np.sqrt(np.square(high - high_ref).mean())),
        "central_crop_highpass_correlation": correlation(high[roi], high_ref[roi]),
        "central_crop_luma_rmse": float(np.sqrt(np.square(y[roi] - yr[roi]).mean())),
        "luma_mean": float(y.mean()),
        "luma_std": float(y.std()),
    }


def panel(arrays: list[np.ndarray], labels: list[str]) -> Image.Image:
    h, w, _ = arrays[0].shape
    out = Image.new("RGB", (w * len(arrays), h + 32), "black")
    d = ImageDraw.Draw(out)
    for i, (a, label) in enumerate(zip(arrays, labels, strict=True)):
        out.paste(Image.fromarray(np.uint8(np.clip(a, 0, 255))), (w * i, 32))
        d.text((w * i + 10, 9), label, fill="white")
    return out


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    for name in ("before", "after", "reference", "output"):
        p.add_argument(name, type=Path)
    p.add_argument("--check", action="store_true", help="Fail on the documented detail/temporal regression criteria")
    args = p.parse_args()
    roots = [args.before, args.after, args.reference]
    loaded = [load(root) for root in roots]
    reports, frames = zip(*loaded, strict=True)
    names = list(frames[0])
    assert all(set(f) == set(names) for f in frames), "Frame set changed"
    assert all(r["epochSeconds"] == 0 and r["exposure"] == 0.15 for r in reports)
    for key in ("viewport", "dpr"):
        assert all(r[key] == reports[0][key] for r in reports), key
    locks = [hashlib.sha256((part / "sources/package-lock.json").read_bytes()).hexdigest() for root in roots for part in parts(root)]
    assert len(set(locks)) == 1, "Dependency snapshots differ"
    args.output.mkdir(parents=True, exist_ok=True)
    data = {"method": "All pixels are compared in the recorded display encoding; no rescaling, exposure fitting, sharpening or alignment. Highpass = luma minus Gaussian(sigma=2 device px). Reference uses independent 0.006 midpoint steps and 1600-step ceiling, with segment quadrature disabled. It is a numerical diagnostic, not astronomical ground truth.", "frames": [], "timing": {}, "sources": {}, "dependency_lock_sha256": locks[0]}
    gifs = []
    residuals: list[list[np.ndarray]] = [[], []]
    for name in names:
        for f in frames[1:]:
            assert f[name]["state"] == frames[0][name]["state"], f"State mismatch: {name}"
            for key in ("observer", "quaternion", "projection"):
                assert np.allclose(f[name]["pose"][key], frames[0][name]["pose"][key], rtol=0, atol=1e-8), (name, key)
        arrays = [image(root, name) for root in roots]
        assert len({a.shape for a in arrays}) == 1
        data["frames"].append({"name": name, "before": measures(arrays[0], arrays[2]), "after": measures(arrays[1], arrays[2])})
        if name in ("gc-wide", "gc-zoom", "cygnus", "external", "motion-08"):
            panel(arrays, ["Merged PR10", "PR11", "Finer midpoint reference"]).save(args.output / f"{name}-comparison.png")
        if name.startswith("motion-") and name[-2:].isdigit():
            gifs.append(panel(arrays[:2], ["Merged PR10 - moving", "PR11 - moving"]))
            for i in range(2):
                residuals[i].append(luma(arrays[i]) - luma(arrays[2]))
    if gifs:
        gifs[0].save(args.output / "translation-before-after.gif", save_all=True, append_images=gifs[1:], duration=220, loop=0, disposal=2)
    data["temporal_residual_rms"] = {
        key: float(np.sqrt(np.square(np.diff(np.stack(r), axis=0)).mean()))
        for key, r in zip(("before", "after"), residuals, strict=True)
    }
    for key, root, report in zip(("before", "after", "reference"), roots, reports, strict=True):
        data["timing"][key] = {"method": report["timingMethod"], "gpu": report["gpu"], "motion_with_readback_ms": report.get("motionReadbackTiming"), "target_bytes": sorted({f["stats"]["targetBytes"] for f in report["frames"]}), "refinement_poll_latency_ms": {f["name"]: f["refinement"]["latencyMs"] for f in report["frames"] if "refinement" in f}}
        data["sources"][key] = [{n: (part / "sources" / n).read_text().strip() for n in ("head-sha.txt", "base-sha.txt")} for part in parts(root)]
    moving = [f for f in data["frames"] if f["name"].startswith("motion-") and f["name"][-2:].isdigit()]
    means = {key: float(np.mean([f[key]["luma_rmse"] for f in moving])) for key in ("before", "after")}
    data["motion_mean_luma_rmse"] = means
    data["acceptance"] = {
        "moving_rmse_improves": means["after"] < means["before"],
        "static_rmse_within_five_percent": all(f["after"]["luma_rmse"] <= 1.05 * f["before"]["luma_rmse"] + 0.02 for f in data["frames"] if f["name"] in ("gc-wide", "gc-zoom", "cygnus", "external")),
        "temporal_residual_within_ten_percent": data["temporal_residual_rms"]["after"] <= 1.1 * data["temporal_residual_rms"]["before"] + 0.002,
    }
    (args.output / "comparison.json").write_text(json.dumps(data, indent=2) + "\n")
    print(json.dumps(data, indent=2))
    if args.check:
        assert all(data["acceptance"].values()), data["acceptance"]


if __name__ == "__main__":
    main()
