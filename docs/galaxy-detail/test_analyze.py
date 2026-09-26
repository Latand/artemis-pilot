"""Guard unchanged-render acceptance without weakening the improvement gate."""
from copy import deepcopy
import unittest
from analyze import EXPECTED_FRAMES, acceptance


def fixture():
    return [{"name": name, "pixel_identical": True,
             "before": {"luma_rmse": 2.0}, "after": {"luma_rmse": 2.0}}
            for name in sorted(EXPECTED_FRAMES)]


class AcceptanceTests(unittest.TestCase):
    def test_identical_is_not_regression(self):
        self.assertTrue(all(acceptance(fixture(), {"before": 1, "after": 1}).values()))

    def test_improvement_experiment_stays_strict(self):
        self.assertFalse(all(acceptance(fixture(), {"before": 1, "after": 1}, True).values()))

    def test_equal_metrics_do_not_prove_equal_pixels(self):
        frames = fixture()
        frames[0]["pixel_identical"] = False
        self.assertFalse(all(acceptance(frames, {"before": 1, "after": 1}).values()))

    def test_real_improvement_still_passes(self):
        frames = fixture()
        for f in frames:
            f["pixel_identical"] = False
            f["after"]["luma_rmse"] = 1.5
        self.assertTrue(all(acceptance(frames, {"before": 1, "after": .9}, True).values()))

    def test_worse_motion_is_not_unchanged(self):
        frames = fixture()
        f = next(f for f in frames if f["name"] == "motion-01")
        f["pixel_identical"] = False
        f["after"]["luma_rmse"] = 2.1
        self.assertFalse(all(acceptance(frames, {"before": 1, "after": 1}).values()))

    def test_static_and_temporal_bounds_remain(self):
        frames = fixture()
        for f in frames:
            f["pixel_identical"] = False
            f["after"]["luma_rmse"] = 1.5
        bad_static = deepcopy(frames)
        next(f for f in bad_static if f["name"] == "gc-wide")["after"]["luma_rmse"] = 3
        self.assertFalse(all(acceptance(bad_static, {"before": 1, "after": 1}).values()))
        self.assertFalse(all(acceptance(frames, {"before": 1, "after": 1.2}).values()))

    def test_empty_partial_and_duplicate_frames_fail(self):
        frames = fixture()
        for invalid in ([], frames[:-1], [frames[0]] * len(frames)):
            with self.assertRaises(AssertionError):
                acceptance(invalid, {"before": 1, "after": 1})


if __name__ == "__main__":
    unittest.main()
