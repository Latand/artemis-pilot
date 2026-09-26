"""Validate and assemble native before/after navigation evidence.

Usage: python docs/navigation-visuals/review.py ARTIFACT_DIRECTORY OUTPUT
Unzip navigation-{render,mobile,merger}-{before,after} into same-named folders
inside ARTIFACT_DIRECTORY. Dependencies are Pillow and numpy (analysis only).
No sharpening, exposure adjustment or rescaling is applied to the PNG panels.
GIF timings are chosen for inspection; they are not recorded frame rates.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def panel(paths: list[Path], labels: list[str]) -> Image.Image:
    images = [Image.open(p).convert("RGB") for p in paths]
    assert len({im.size for im in images}) == 1, "Output dimensions changed"
    w, h = images[0].size
    out = Image.new("RGB", (w * len(images), h + 34), "black")
    draw = ImageDraw.Draw(out)
    for i, (im, label) in enumerate(zip(images, labels, strict=True)):
        out.paste(im, (i * w, 34))
        draw.text((i * w + 10, 11), label, fill="white")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    reports, roots, sources, locks = {}, {}, [], []
    for suite in ("render", "mobile", "merger"):
        for variant in ("before", "after"):
            root = args.artifacts / f"navigation-{suite}-{variant}"
            roots[suite, variant] = root / suite
            report = json.loads((root / suite / "report.json").read_text())
            assert not report["errors"], (suite, variant, report["errors"])
            assert report["checks"], (suite, variant, "No assertions executed")
            if variant == "after":
                assert all(c.get("pass") is True for c in report["checks"]), (suite, report["checks"])
            reports[suite, variant] = report
            sources.append({k: (root / "sources" / k).read_text().strip()
                            for k in ("head-sha.txt", "base-sha.txt")})
            locks.append(hashlib.sha256((root / "sources/package-lock.json").read_bytes()).hexdigest())
    assert all(s == sources[0] for s in sources), "Mixed source revisions"
    assert len(set(locks)) == 1, "Different dependency snapshots"
    matched = []
    for suite in ("mobile", "merger"):
        before = reports[suite, "before"]["frames"]
        after = {f["name"]: f for f in reports[suite, "after"]["frames"]}
        expected = ({"compact-390x844", "compact-320x568", "compact-500x850", "compact-844x390"}
                    if suite == "mobile" else {"merger-0", "merger-3.9", "merger-4.4", "merger-8", "merger-13.6", "merger-13.6-close"})
        assert {f["name"] for f in before} == expected and expected <= set(after)
        for frame in before:
            for key in ("t", "focus", "camera", "quaternion", "projection", "dpr", "size"):
                assert frame[key] == after[frame["name"]][key], (suite, frame["name"], key)
            matched.append(f"{suite}/{frame['name']}")
    before = {f["name"]: f for f in reports["render", "before"]["captures"]}
    after = {f["name"]: f for f in reports["render", "after"]["captures"]}
    assert set(before) == set(after) and len(before) == 9
    for name, frame in before.items():
        keys = ("time", "period", "primary", "orbitalRadiusAu") if name.startswith("trail-") else ("type", "inc", "pixels")
        for key in keys:
            assert frame[key] == after[name][key], (name, key)
        matched.append(f"render/{name}")
    labels = ["Before - merged PR11", "After - PR12"]
    output_panels = []
    for suite, names in {
        "render": ["spiral", "inclined", "edge", "irregular", "elliptical", "trail-recent", "trail-undersampled"],
        "mobile": ["compact-390x844", "compact-320x568", "compact-844x390"],
        "merger": ["merger-4.4", "merger-13.6-close"],
    }.items():
        for name in names:
            paths = [roots[suite, v] / f"{name}.png" for v in ("before", "after")]
            file = f"{name}-comparison.png"
            panel(paths, labels).save(args.output / file)
            output_panels.append(file)
    fade = [panel([roots["render", v] / f"trail-fade-{age}.png" for v in ("before", "after")],
                  [f"{label} - age {age} orbits" for label in labels]) for age in (0, .25, .5, .75, 1, 1.2)]
    fade[0].save(args.output / "trail-fade.gif", save_all=True, append_images=fade[1:],
                 duration=[500, 300, 300, 300, 300, 1000], loop=0, disposal=2)
    # This is a pixel-coverage diagnostic, not a measure of astronomical accuracy.
    coverage = {}
    for name in ("trail-recent", "trail-undersampled"):
        coverage[name] = {}
        for variant in ("before", "after"):
            rgb = np.asarray(Image.open(roots["render", variant] / f"{name}.png").convert("RGB"))
            coverage[name][variant] = int(np.count_nonzero(np.max(rgb, axis=2) > 8))
    summary = {
        "sources": sources[0], "dependency_lock_sha256": locks[0], "matched_captures": matched,
        "after_checks": {s: len(reports[s, "after"]["checks"]) for s in ("render", "mobile", "merger")},
        "baseline_defects": {s: [c["name"] for c in reports[s, "before"]["checks"] if not c.get("pass")]
                             for s in ("render", "mobile", "merger")},
        "trail_coverage_pixels_over_8": coverage, "panels": output_panels,
        "method": "Native PNG pixels; no image enhancement. Matching checks cover recorded states, not unrecorded settings. Merger exposure is fixed at 0.35 in the capture script. The fade sequence advances simulation age with no new samples; GIF timing is illustrative. This is not hardware performance or observational calibration.",
    }
    (args.output / "review.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
