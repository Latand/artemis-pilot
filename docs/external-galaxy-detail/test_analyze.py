"""The report fails closed on missing images/sources or mismatched cameras."""
import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
from PIL import Image
spec = importlib.util.spec_from_file_location('analyze', Path(__file__).with_name('analyze.py'))
a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)
frame = {'state': {'camera': {'position': [10,20,30], 'quaternion': [0,0,0,1], 'fov': 48, 'aspect': 1.5}, 'time': 0}, 'test': {'name': 'case'}}
assert a.compare_camera(frame, frame)['matched']
import copy
changed = copy.deepcopy(frame); changed['state']['camera']['position'][0] += .1
assert not a.compare_camera(frame, changed)['matched']
changed = copy.deepcopy(frame); changed['state']['time'] = 1
assert not a.compare_camera(frame, changed)['matched']
with TemporaryDirectory() as tmp:
    root = Path(tmp); png = root / 'test.png'; Image.new('RGB', (16,12), (255,255,255)).save(png)
    m = a.image_metrics(png); assert m['saturated_fraction'] == 1 and m['gradient_mean'] == 0
    r = a.analyze(root / 'absent', root / 'review'); assert not r['passed'] and len(r['pairs']) == 0
    assert (root / 'review' / 'index.html').is_file()
print('PASS external-galaxy comparison: missing evidence, changed camera/epoch fail; image metrics and report render')
