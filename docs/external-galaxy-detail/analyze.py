"""Compare exact-source screenshots without a subjective automatic beauty score.

Raw PNGs remain unmodified. Contact sheets are labeled previews; the HTML links
full-resolution copies. Runtime, source identity, camera, case count, shader/GL,
and center-cull assertions gate CI. Image metrics support human review only.
"""
from __future__ import annotations
import argparse
import html
import json
from pathlib import Path
import shutil
import sys
import numpy as np
from PIL import Image, ImageDraw

DEVICES = ('desktop', 'mobile')
SUITES = ('m31', 'zoom', 'catalog')

def image_metrics(path):
    rgb = np.asarray(Image.open(path).convert('RGB'), dtype=np.float64)
    y = rgb @ np.array([.2126, .7152, .0722])
    dx = np.abs(np.diff(y, axis=1))
    dy = np.abs(np.diff(y, axis=0))
    # Higher spatial gradients can mean detail, aliasing OR a hard cut edge.
    # Deliberately report these as diagnostics, never as a fidelity verdict.
    return {'size': [int(rgb.shape[1]), int(rgb.shape[0])], 'mean_luma': float(y.mean()),
            'std_luma': float(y.std()), 'nonblack_fraction': float((y > 3).mean()),
            'saturated_fraction': float((rgb.max(axis=2) >= 254).mean()),
            'gradient_mean': float((dx.mean() + dy.mean()) / 2),
            'gradient_p99': float(np.percentile(np.concatenate([dx.ravel(), dy.ravel()]), 99))}

def compare_camera(before, after):
    a, b = before['state']['camera'], after['state']['camera']
    scale = max(1., np.linalg.norm(a['position']))
    relative_position = float(np.linalg.norm(np.array(a['position']) - b['position']) / scale)
    qa, qb = np.array(a['quaternion']), np.array(b['quaternion'])
    rotation = float(min(np.linalg.norm(qa-qb), np.linalg.norm(qa+qb)))
    return {'relative_position_error': relative_position, 'quaternion_error': rotation,
            'matched': relative_position < 1e-9 and rotation < 1e-7 and
            a['fov'] == b['fov'] and a['aspect'] == b['aspect'] and
            before['state']['time'] == after['state']['time'] and before['test'] == after['test']}

def contact_sheet(rows, output):
    thumb_w = 480
    cards = []
    for name, left, right in rows:
        pics = []
        for path in [left, right]:
            im = Image.open(path).convert('RGB'); im.thumbnail((thumb_w, 430), Image.Resampling.LANCZOS); pics.append(im)
        height = max(im.height for im in pics) + 48
        card = Image.new('RGB', (thumb_w * 2, height), '#10141a'); d = ImageDraw.Draw(card)
        d.text((10, 7), name, fill='white')
        for i, im in enumerate(pics):
            d.text((i * thumb_w + 10, 25), 'BEFORE' if i == 0 else 'AFTER', fill='#a7b3c1')
            card.paste(im, (i * thumb_w + (thumb_w-im.width)//2, 46))
        cards.append(card)
    if not cards: return
    canvas = Image.new('RGB', (thumb_w * 2, sum(c.height for c in cards)), '#10141a')
    y = 0
    for card in cards: canvas.paste(card, (0,y)); y += card.height
    canvas.save(output)

def analyze(raw, output):
    raw, output = Path(raw), Path(output); output.mkdir(parents=True, exist_ok=True)
    failures, results, sections, identities = [], [], [], []
    for device in DEVICES:
        for suite in SUITES:
            reports, dirs = {}, {}
            for variant in ['before', 'after']:
                base = raw / f'external-{variant}-{device}-{suite}'
                path = base / 'capture' / 'report.json'; dirs[variant] = base / 'capture'
                if not path.is_file(): failures.append(f'Missing report: {variant}/{device}/{suite}'); continue
                r = json.loads(path.read_text()); reports[variant] = r
                sha_file = base / 'sources' / ('base-sha.txt' if variant == 'before' else 'head-sha.txt')
                expected_sha = sha_file.read_text().strip() if sha_file.is_file() else None
                identities.append({'variant': variant, 'device': device, 'suite': suite, 'revision': r.get('revision'), 'expected': expected_sha})
                if not expected_sha or r.get('revision') != expected_sha: failures.append(f'{variant}/{device}/{suite}: source SHA mismatch')
                if not r.get('completed') or len(r['frames']) != len(r['expectedCases']): failures.append(f'{variant}/{device}/{suite}: incomplete capture')
                if r.get('errors') or r.get('failedRequests'): failures.append(f'{variant}/{device}/{suite}: runtime or network errors')
                if variant == 'after' and r.get('failedChecks'): failures.append(f'after/{device}/{suite}: {r["failedChecks"]}')
                shutil.copy2(path, output / f'{variant}-{device}-{suite}-report.json')
            if len(reports) != 2: continue
            before = {f['name']: f for f in reports['before']['frames']}; after = {f['name']: f for f in reports['after']['frames']}
            if set(before) != set(after): failures.append(f'{device}/{suite}: case-set mismatch')
            app_rows, target_rows = [], []
            section = [f'<h2>{device} · {suite}</h2>']
            for name in reports['after']['expectedCases']:
                if name not in before or name not in after: continue
                check = compare_camera(before[name], after[name])
                if not check['matched']: failures.append(f'{device}/{suite}/{name}: unmatched camera or epoch')
                result = {'device': device, 'suite': suite, 'name': name, 'camera': check,
                          'before_assertions': before[name]['assertions'], 'after_assertions': after[name]['assertions'],
                          'before_coverage': before[name]['coverage'], 'after_coverage': after[name]['coverage']}
                section.append(f'<h3>{html.escape(name)}</h3>')
                for suffix, key in [('', 'app'), ('-target', 'target')]:
                    paths = []
                    section.append(f'<div class="kind">{key}: full resolution, no image edits</div><div class="pair">')
                    for variant in ['before', 'after']:
                        path = dirs[variant] / f'{name}{suffix}.png'
                        if not path.is_file(): failures.append(f'Missing image {path}'); continue
                        dest = output / f'{device}-{suite}-{name}{suffix}-{variant}.png'; shutil.copy2(path, dest); paths.append(dest)
                        result[f'{variant}_{key}_metrics'] = image_metrics(path)
                        section.append(f'<figure><figcaption>{variant}</figcaption><a href="{dest.name}"><img src="{dest.name}" loading="lazy"></a></figure>')
                    section.append('</div>')
                    if len(paths) == 2: (target_rows if suffix else app_rows).append((name, *paths))
                section.append(f'<details><summary>Camera, coverage and runtime assertions</summary><pre>{html.escape(json.dumps(result, indent=2))}</pre></details>')
                results.append(result)
            contact_sheet(app_rows, output / f'{device}-{suite}-app-contact.png')
            contact_sheet(target_rows, output / f'{device}-{suite}-target-contact.png')
            sections.append('\n'.join(section))
    before_shas = {i['revision'] for i in identities if i['variant'] == 'before'}
    after_shas = {i['revision'] for i in identities if i['variant'] == 'after'}
    if len(before_shas) != 1 or len(after_shas) != 1: failures.append('Source revisions differ across shards')
    report = {'passed': not failures, 'failures': failures, 'source_identities': identities, 'pairs': results}
    (output / 'comparison.json').write_text(json.dumps(report, indent=2) + '\n')
    title = 'PASS' if not failures else 'FAIL'
    summary = f'# External galaxy screenshot QA: {title}\n\n' + f'{len(results)} matched before/after view pairs across desktop and mobile.\n\n'
    summary += f'Before: {", ".join(str(s) for s in before_shas)}\n\nAfter: {", ".join(str(s) for s in after_shas)}\n\n'
    summary += 'Download `external-galaxy-review` and open `index.html`. Raw full-app and live-target PNGs, per-frame reports, source SHAs, camera checks, pixel diagnostics, and labeled contact sheets are retained.\n\n'
    summary += 'Automatic checks cover complete captures, exact source revisions, matching cameras/epochs, real catalog types, JS/shader/WebGL errors, visible target pixels, and center-behind/off-axis support. Artistic detail, physical plausibility, aliasing, and hard geometric cut edges still require visual review.\n'
    if failures: summary += '\n## Failures\n' + '\n'.join('- ' + f for f in failures) + '\n'
    (output / 'summary.md').write_text(summary)
    page = '<!doctype html><meta charset="utf-8"><title>External galaxies: before / after</title><style>body{background:#11151b;color:#e3e8ef;font:15px system-ui;margin:24px}h2{margin-top:60px}a{color:#adceff}.pair{display:flex;gap:12px;align-items:start}figure{margin:0;width:50%}img{max-width:100%;height:auto;background:black}figcaption,.kind{padding:8px 0;color:#adb8c8}pre{white-space:pre-wrap}details{margin:12px 0 32px}</style>'
    page += f'<h1>External galaxy detail: {title}</h1><p>{len(results)} identical before/after camera fixtures. Images labeled “target” isolate the actual live instance using its unchanged production material and uniforms.</p>'
    page += '<p>Raw images are linked at original resolution. No brightness matching, blur, sharpening or pixel edits. Contact-sheet resizing is for navigation only. Image-detail metrics are diagnostic, not a fidelity score.</p>'
    page += '<pre>' + html.escape('\n'.join(failures) or 'All automated capture and geometry assertions passed.') + '</pre>' + '\n'.join(sections)
    (output / 'index.html').write_text(page)
    return report

if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('raw'); p.add_argument('output'); p.add_argument('--check', action='store_true'); args = p.parse_args()
    report = analyze(args.raw, args.output)
    print(json.dumps({'passed': report['passed'], 'pairs': len(report['pairs']), 'failures': report['failures']}, indent=2))
    sys.exit(1 if args.check and not report['passed'] else 0)
