import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.server import app, slider_levels  # noqa: E402
from app.core import planner  # noqa: E402
from app.core.planner import build_preview  # noqa: E402
from app.core.sample import make_sample  # noqa: E402

CHAR_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "app", "data", "characters")


def load_char(cid):
    with open(os.path.join(CHAR_DIR, f"{cid}.json"), encoding="utf-8") as f:
        return json.load(f)


class PreviewCoreTest(unittest.TestCase):
    def setUp(self):
        self.mu = load_char("mu")["strokes"]
        self.strokes = make_sample(self.mu)
        self.levels = slider_levels()

    def test_default_slider_stops_are_40_to_600_step10(self):
        self.assertEqual(self.levels[0], 40)
        self.assertEqual(self.levels[-1], 600)
        self.assertEqual(len(self.levels), 57)
        self.assertEqual(self.levels, sorted(set(self.levels)))

    def test_each_pair_frechet_computed_exactly_once(self):
        K, N = len(self.strokes), len(self.mu)
        real = planner.discrete_frechet
        calls = []

        def counting(p, q):
            calls.append((len(calls),))
            return real(p, q)

        with mock.patch.object(planner, "discrete_frechet", side_effect=counting) as m:
            pv = build_preview(self.strokes, self.mu, [40, 80, 180, 600])
        self.assertTrue(pv["feasible"])
        self.assertEqual(m.call_count, K * N)
        self.assertEqual(pv["pair_count"], K * N)
        self.assertEqual(len(calls), K * N)

    def test_solve_count_equals_distinct_compatibility_matrices(self):
        pv = build_preview(self.strokes, self.mu, self.levels)
        self.assertTrue(pv["feasible"])
        dist = pv["dist"]
        # Independently count distinct entry-wise compatibility matrices.
        matrices = set()
        for lv in pv["levels"]:
            t = lv["threshold"]
            key = tuple(tuple(d <= t + 1e-9 for d in row) for row in dist)
            matrices.add(key)
        self.assertEqual(pv["level_count"], len(self.levels))
        self.assertEqual(pv["solve_count"], len(matrices))
        self.assertLessEqual(pv["solve_count"], len(self.levels))

    def test_identical_candidate_levels_share_one_solve_and_result(self):
        pv = build_preview(self.strokes, self.mu, self.levels)
        dist = pv["dist"]

        def matrix(t):
            return tuple(tuple(d <= t + 1e-9 for d in row) for row in dist)

        # Find two distinct stops producing exactly the same candidates.
        pair = None
        for a in range(len(self.levels)):
            for b in range(a + 1, len(self.levels)):
                if matrix(self.levels[a]) == matrix(self.levels[b]):
                    pair = (self.levels[a], self.levels[b])
                    break
            if pair:
                break
        self.assertIsNotNone(pair, "sample should have redundant slider stops")

        two = build_preview(self.strokes, self.mu, list(pair))
        self.assertEqual(two["solve_count"], 1)
        self.assertEqual(two["levels"][0]["feasible"], two["levels"][1]["feasible"])
        self.assertEqual(two["levels"][0]["cost"], two["levels"][1]["cost"])

    def test_preview_levels_match_build_plan_for_every_stop(self):
        # The trial summary for each stop must equal the formal solver result.
        pv = build_preview(self.strokes, self.mu, self.levels)
        by_t = {lv["threshold"]: lv for lv in pv["levels"]}
        for t in self.levels:
            plan = planner.build_plan(self.strokes, self.mu, t)
            lv = by_t[t]
            self.assertEqual(lv["feasible"], plan["feasible"], msg=f"t={t}")
            if plan["feasible"]:
                self.assertEqual(lv["cost"], plan["cost"], msg=f"t={t}")
                self.assertEqual(lv["counts"], plan["counts"], msg=f"t={t}")
            else:
                self.assertFalse(lv["feasible"])
                self.assertTrue(lv["reason"])

    def test_preserved_no_match_is_infeasible_in_preview(self):
        strokes = [dict(s, preserved=(i == len(self.strokes) - 1))
                   for i, s in enumerate(self.strokes)]
        pv = build_preview(strokes, self.mu, [180, 600])
        for lv in pv["levels"]:
            # The extraneous scribble matches nothing at these thresholds.
            self.assertFalse(lv["feasible"])
            self.assertIn("无解", lv["reason"])

    def test_invalid_thresholds_reported(self):
        pv = build_preview(self.strokes, self.mu, ["big"])
        self.assertFalse(pv["feasible"])
        self.assertIn("数字", pv["reason"])
        pv2 = build_preview(self.strokes, self.mu, list(range(201)))
        self.assertFalse(pv2["feasible"])


class PreviewApiTest(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_preview_default_levels_and_aliases(self):
        for path in ("/api/preview", "/api/trial", "/api/trials", "/api/prepare"):
            r = self.client.post(path, json={"character_id": "mu", "strokes": []})
            self.assertEqual(r.status_code, 200, path)
            data = r.get_json()
            self.assertTrue(data["feasible"])
            self.assertEqual(len(data["levels"]), len(slider_levels()))

    def test_preview_sample_matches_plan_endpoint_all_chars(self):
        idx = self.client.get("/api/characters").get_json()["characters"]
        checked = 0
        for c in idx:
            cid = c["id"]
            sample = self.client.get(f"/api/sample/{cid}").get_json()
            strokes = sample["strokes"]
            pv = self.client.post("/api/preview", json={
                "character_id": cid, "strokes": strokes,
                "thresholds": slider_levels(),
            }).get_json()
            self.assertTrue(pv["feasible"], pv.get("reason"))
            for lv in pv["levels"]:
                p = self.client.post("/api/plan", json={
                    "character_id": cid, "strokes": strokes,
                    "threshold": lv["threshold"],
                }).get_json()
                self.assertEqual(lv["feasible"], p["feasible"],
                                 msg=f"{cid} t={lv['threshold']}")
                if p["feasible"]:
                    self.assertEqual(lv["cost"], p["cost"])
                    self.assertEqual(lv["counts"], p["counts"])
                checked += 1
        self.assertGreaterEqual(checked, 8 * 10)

    def test_preview_bad_requests(self):
        r = self.client.post("/api/preview", data="nope",
                             headers={"Content-Type": "application/json"})
        self.assertEqual(r.status_code, 400)
        r2 = self.client.post("/api/preview",
                              json={"character_id": "mu", "thresholds": ["x"]})
        self.assertEqual(r2.status_code, 400)
        r3 = self.client.post("/api/preview", json={"character_id": "ghost"})
        self.assertEqual(r3.status_code, 404)


if __name__ == "__main__":
    unittest.main()
