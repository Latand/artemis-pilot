"""Compare corresponding texture in the captured rotation sequence.

Optional evidence-review dependencies (not application dependencies):
    python -m pip install numpy scipy pillow
Usage:
    python docs/analyze-galaxy-motion.py BEFORE_DIR AFTER_DIR OUTPUT_DIR
The first two directories must contain 04-return.png and motion-00..15.png
from scripts/verify-galaxy-rendering.mjs. OUTPUT_DIR receives JSON, native
before/after crops, a side-by-side PNG and a 16-frame GIF. No sharpening.
"""
import argparse
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import map_coordinates, gaussian_filter

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('before', type=Path)
parser.add_argument('after', type=Path)
parser.add_argument('output', type=Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
results = {}
size = None
for name, directory in [('before', args.before), ('after', args.after)]:
    reference = np.asarray(Image.open(directory / '04-return.png').convert('RGB'), dtype=float)
    height, width = reference.shape[:2]
    if size is not None and size != (width, height):
        raise ValueError('Before and after capture sizes differ')
    size = width, height
    py, px = np.mgrid[0:height, 0:width]
    ty = np.tan(np.deg2rad(24))  # capture harness: vertical FOV 48 degrees
    tx = ty * width / height
    x = (2 * (px + .5) / width - 1) * tx
    y = (1 - 2 * (py + .5) / height) * ty
    rows = []
    for i in range(16):
        angle = (i + 1) * .002  # camera.rotateY in the capture script
        c, s = np.cos(angle), np.sin(angle)
        ox, oy, oz = c * x - s, y, -s * x - c
        sx = (ox / -oz / tx + 1) * width / 2 - .5
        sy = (1 - oy / -oz / ty) * height / 2 - .5
        image = np.asarray(Image.open(directory / f'motion-{i:02}.png').convert('RGB'), dtype=float)
        if image.shape != reference.shape:
            raise ValueError(f'Unexpected frame size: {directory}, frame {i}')
        warped = np.stack([map_coordinates(reference[..., j], [sy, sx], order=1, mode='nearest') for j in range(3)], axis=-1)
        luminance = warped @ np.array([.2126, .7152, .0722])
        mask = (sx > 8) & (sx < width - 9) & (sy > 8) & (sy < height - 9) & (luminance > 25) & (luminance < 220)
        if np.count_nonzero(mask) < 100:
            raise ValueError('Insufficient common sky texture')
        detail = image.mean(-1) - gaussian_filter(image.mean(-1), 1.5)
        target = warped.mean(-1) - gaussian_filter(warped.mean(-1), 1.5)
        if np.std(target[mask]) <= 1e-8:
            raise ValueError('Reference texture has no measurable contrast')
        rows.append({'frame': i, 'aligned_mae_rgb_255': float(np.abs(image - warped)[mask].mean()),
                     'detail_correlation': float(np.corrcoef(detail[mask], target[mask])[0, 1]),
                     'detail_rms_ratio': float(np.std(detail[mask]) / np.std(target[mask]))})
    results[name] = {'frames': rows, **{key: float(np.mean([row[key] for row in rows])) for key in rows[0] if key != 'frame'}}
results['method'] = 'Known perspective homography, same observer; fresh return-pose reference avoids stale post-resize baseline. Bilinear display-space reprojection. Eight-pixel margins and target luminance 25..220/255 mask. Texture is mean RGB minus Gaussian sigma 1.5px. Diagnostic of this rotation sequence, not a universal quality score.'
(args.output / 'aligned-motion-analysis.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
width, height = size
sequence = []
for i in range(16):
    canvas = Image.new('RGB', (2 * width, height + 30), (18, 18, 18))
    draw = ImageDraw.Draw(canvas)
    for n, (label, directory) in enumerate([('Before', args.before), ('After', args.after)]):
        canvas.paste(Image.open(directory / f'motion-{i:02}.png').convert('RGB'), (n * width, 30))
        draw.text((n * width + 10, 10), f'{label} | frame {i+1}/16', fill='white')
    sequence.append(canvas)
sequence[8].save(args.output / 'motion-before-after.png')
sequence[0].save(args.output / 'motion-before-after.gif', save_all=True, append_images=sequence[1:], duration=130, loop=0)
box = (width // 4, height // 8, 3 * width // 4, 7 * height // 8)
cw, ch = box[2] - box[0], box[3] - box[1]
crops = Image.new('RGB', (2 * cw, ch + 30), (18, 18, 18))
for n, (label, directory) in enumerate([('Before', args.before), ('After', args.after)]):
    crops.paste(Image.open(directory / 'motion-08.png').convert('RGB').crop(box), (n * cw, 30))
    ImageDraw.Draw(crops).text((n * cw + 10, 10), label + ' | native crop', fill='white')
crops.save(args.output / 'native-detail-crops.png')
print(json.dumps({name: {key: value for key, value in data.items() if key != 'frames'} for name, data in results.items() if isinstance(data, dict)}, indent=2))
