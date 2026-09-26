"""Compare seven matched moving-volume experiments without image adjustment.

Usage: python docs/galaxy-motion/analyze.py ARTIFACT_PARENT OUTPUT [--check]
Requires numpy, scipy and Pillow for offline analysis only.
"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter

MODES = ('before', 'after', 'native', 'integration', 'step035', 'step045', 'reference')
NAMES = ['wide', 'cygnus', 'home', *[f'move-{i:02}' for i in range(1, 9)],
         'stop-immediate', 'stop-settled', 'return', 'small-start', 'fov-24', 'fov-12', 'fov-18',
         'resize-600-300-1', 'resize-300-500-1', 'resize-300-500-1.5', 'resize-480-300-1']
MOVING = [f'move-{i:02}' for i in range(1, 9)]
STATIC = ['wide', 'cygnus', 'home', 'stop-settled', 'return']


def luma(a):
    return a @ np.array([.2126, .7152, .0722])


def metrics(a, b):
    x, y = luma(a), luma(b)
    hx, hy = x-gaussian_filter(x, 2), y-gaussian_filter(y, 2)
    hx -= hx.mean(); hy -= hy.mean()
    norm = np.linalg.norm(hx)*np.linalg.norm(hy)
    return dict(rmse=float(np.sqrt(np.mean((x-y)**2))), rgb_mae=float(np.abs(a-b).mean()),
                highpass_correlation=float(np.sum(hx*hy)/norm) if norm > 1e-9 else None)


def panel(arrays, labels):
    h,w,_ = arrays[0].shape
    result = Image.new('RGB',(len(arrays)*w,h+28),'black'); d=ImageDraw.Draw(result)
    for i,(array,label) in enumerate(zip(arrays,labels)):
        result.paste(Image.fromarray(array.astype('uint8')),(i*w,28))
        d.text((i*w+8,8),label,fill='white')
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root',type=Path);parser.add_argument('output',type=Path)
    parser.add_argument('--check',action='store_true');args=parser.parse_args()
    roots={m:args.root/f'galaxy-motion-{m}' for m in MODES}
    reports={m:json.loads((root/'motion/report.json').read_text()) for m,root in roots.items()}
    locks={hashlib.sha256((root/'sources/package-lock.json').read_bytes()).hexdigest() for root in roots.values()}
    assert len(locks)==1, 'Different dependency snapshots'
    frames={m:{f['name']:f for f in r['frames']} for m,r in reports.items()}
    sources={m:{n:(root/'sources'/n).read_text().strip() for n in ('base-sha.txt','head-sha.txt')} for m,root in roots.items()}
    assert all(s==sources['before'] for s in sources.values()), 'Different comparison revisions'
    for m,r in reports.items():
        assert r['mode']==m and r['completed'] and not r['errors'], f'Incomplete/error capture: {m}'
        assert r['checks'] and all(c['pass'] for c in r['checks']), f'Capture assertions: {m}'
        assert list(frames[m])==NAMES, f'Missing or duplicate frames: {m}'
        assert len(r['frames'])==len(NAMES), f'Duplicate frames: {m}'
        assert r['epoch']==0 and r['exposure']==.15
        assert r['executedSourceSha']==sources[m]['head-sha.txt' if m=='after' else 'base-sha.txt'], 'Wrong executed root'
        assert r['gpu']==reports['before']['gpu'], 'Different renderer'
    images={m:{} for m in MODES};out={'frames':{},'sources':sources,'gpu':reports['after']['gpu']}
    args.output.mkdir(parents=True,exist_ok=True)
    for name in NAMES:
        for m in MODES:
            assert frames[m][name]['settings']==frames['before'][name]['settings'], (m,name,'different view')
            images[m][name]=np.asarray(Image.open(roots[m]/'motion'/f'{name}.png').convert('RGB'),dtype=float)
        out['frames'][name]={m:metrics(images[m][name],images['reference'][name]) for m in MODES[:-1]}
    out['motion_mean_rmse']={m:float(np.mean([out['frames'][n][m]['rmse'] for n in MOVING])) for m in MODES[:-1]}
    out['temporal_residual_rms']={m:float(np.sqrt(np.mean(np.diff(np.stack([luma(images[m][n])-luma(images['reference'][n]) for n in MOVING]),axis=0)**2))) for m in ('before','after')}
    out['stop_gap']={m:metrics(images[m]['stop-immediate'],images[m]['stop-settled'])['rmse'] for m in ('before','after')}
    out['timing']={}
    for m in MODES:
        values=np.array([frames[m][n]['drawReadbackMs'] for n in MOVING])
        out['timing'][m]={'method':reports[m]['timingMethod'],'n':len(values),'p50_ms':float(np.median(values)),
                          'p95_ms':float(np.quantile(values,.95)),'max_ms':float(values.max())}
    out['resources']={n:frames['after'][n]['stats'] for n in MOVING}
    means=out['motion_mean_rmse'];tr=out['temporal_residual_rms']
    out['acceptance']={
        'moving_rmse_at_least_five_percent_lower':means['after']<=.95*means['before'],
        'no_moving_frame_regression':all(out['frames'][n]['after']['rmse']<=out['frames'][n]['before']['rmse']+.02 for n in MOVING),
        'settled_pixels_unchanged':all(np.array_equal(images['before'][n],images['after'][n]) for n in STATIC),
        'temporal_error_within_ten_percent':tr['after']<=1.1*tr['before']+.002,
        'stop_gap_smaller':out['stop_gap']['after']<out['stop_gap']['before'],
        'fresh_bounded_integration':all(not frames['after'][n]['stats']['historyUsed'] and frames['after'][n]['stats']['integrationStep']==.04 and frames['after'][n]['stats']['maxRaySteps']==360 for n in MOVING),
        'no_extra_targets_or_output_pixels':all(frames['after'][n]['stats']['targetBytes']==frames['before'][n]['stats']['targetBytes'] and frames['after'][n]['stats']['res']==frames['before'][n]['stats']['res'] for n in NAMES),
    }
    for name in ('move-01','move-04','move-08','small-start','fov-12'):
        panel([images[m][name] for m in ('before','after','reference')],['Merged baseline','Balanced ray steps','Full-grid / settled-step control']).save(args.output/f'{name}-comparison.png')
    gif=[panel([images[m][name] for m in ('before','after')],['Before - moving','After - moving']) for name in MOVING]
    gif[0].save(args.output/'motion-before-after.gif',save_all=True,append_images=gif[1:],duration=200,loop=0,disposal=2)
    out['method']='All encoded RGB pixels, same view/exposure and no alignment, rescaling or sharpening. Reference uses the unchanged field at full grid and settled 0.03 step, not astronomical truth. GIF timing is illustrative, not FPS.'
    (args.output/'comparison.json').write_text(json.dumps(out,indent=2)+'\n')
    print(json.dumps({k:v for k,v in out.items() if k not in ('resources','frames')},indent=2))
    if args.check: assert all(out['acceptance'].values()),out['acceptance']

if __name__=='__main__':main()
