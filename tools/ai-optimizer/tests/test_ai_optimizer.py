#!/usr/bin/env python3
"""Tests for the ai-optimizer queue — focused on the evidence bar and dedup,
the two rules the whole tool exists to enforce."""
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import ai_optimizer as q


def good_meta(**over):
    m = {
        "title": "news-writer burns turn budget on max-turns failures",
        "finding_class": "max-turns-waste",
        "scope": "site",
        "sites": ["0daynews.com"],
        "role": "news-writer",
        "window_from": "2026-08-18",
        "window_to": "2026-08-25",
        "measured_cost_usd": 8.64,
        "estimated_savings_usd_per_day": 1.2,
        "risk": "low",
        "verified_current_code": True,
        "verified_git_check": "git log -3 ops/scripts/run-news-writer.sh — no gating commit in window",
        "evidence_files": ["sites/0daynews.com/ops/scripts/run-news-writer.sh:45"],
    }
    m.update(over)
    return m


class TempQueue(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        for s in q.STATUSES:
            (self.root / s).mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)


class TestValidation(TempQueue):
    def test_accepts_well_formed(self):
        self.assertEqual(q.validate(good_meta())["risk"], "low")

    def test_rejects_telemetry_only_finding(self):
        """The core rule: no ticket without confirming the live code."""
        with self.assertRaises(q.ValidationError) as cm:
            q.validate(good_meta(verified_current_code=False))
        self.assertIn("verified_current_code", str(cm.exception))

    def test_rejects_missing_git_check(self):
        with self.assertRaises(q.ValidationError) as cm:
            q.validate(good_meta(verified_git_check=""))
        self.assertIn("verified_git_check", str(cm.exception))

    def test_rejects_no_evidence_files(self):
        with self.assertRaises(q.ValidationError):
            q.validate(good_meta(evidence_files=[]))

    def test_rejects_zero_or_missing_cost(self):
        with self.assertRaises(q.ValidationError):
            q.validate(good_meta(measured_cost_usd=0))
        with self.assertRaises(q.ValidationError):
            q.validate(good_meta(measured_cost_usd=None))

    def test_rejects_bad_window(self):
        with self.assertRaises(q.ValidationError):
            q.validate(good_meta(window_from="2026-08-26", window_to="2026-08-25"))
        with self.assertRaises(q.ValidationError):
            q.validate(good_meta(window_from="last week"))

    def test_rejects_site_scope_with_no_sites(self):
        with self.assertRaises(q.ValidationError):
            q.validate(good_meta(scope="site", sites=[]))

    def test_rejects_bad_risk_and_scope(self):
        with self.assertRaises(q.ValidationError):
            q.validate(good_meta(risk="spicy"))
        with self.assertRaises(q.ValidationError):
            q.validate(good_meta(scope="galaxy"))


class TestDedup(TempQueue):
    def test_same_finding_suppressed(self):
        _, out1 = q.file_ticket(good_meta(), "body", root=self.root)
        self.assertEqual(out1, "created")
        # Reworded title + drifted cost is still the SAME finding.
        _, out2 = q.file_ticket(
            good_meta(title="Turn cap wasting money on 0daynews", measured_cost_usd=9.9),
            "body", root=self.root)
        self.assertIn("suppressed", out2)

    def test_rejected_finding_is_not_refiled(self):
        """A denied ticket must not come back every morning."""
        fp, _ = q.file_ticket(good_meta(), "body", root=self.root)
        q.move(fp.name, "rejected", root=self.root, note="not worth it")
        _, out = q.file_ticket(good_meta(), "body", root=self.root)
        self.assertIn("suppressed", out)
        self.assertIn("rejected", out)

    def test_different_site_is_a_different_finding(self):
        q.file_ticket(good_meta(), "body", root=self.root)
        _, out = q.file_ticket(good_meta(sites=["rodhat.com"]), "body", root=self.root)
        self.assertEqual(out, "created")

    def test_force_overrides_suppression(self):
        q.file_ticket(good_meta(), "body", root=self.root)
        _, out = q.file_ticket(good_meta(), "body", root=self.root, force=True)
        self.assertEqual(out, "created")


class TestRoundTrip(TempQueue):
    def test_serialize_parse_roundtrip(self):
        meta = good_meta()
        text = q.serialize({**meta, "ticket_id": "t1", "status": "proposed"}, "## Problem\n\nbody")
        back, body = q.parse(text)
        self.assertEqual(back["evidence_files"], meta["evidence_files"])
        self.assertIs(back["verified_current_code"], True)
        self.assertEqual(back["measured_cost_usd"], 8.64)
        self.assertIn("## Problem", body)

    def test_move_records_decision(self):
        fp, _ = q.file_ticket(good_meta(), "body", root=self.root)
        q.move(fp.name, "approved", root=self.root, note="do it", by="jesse")
        rows = q.list_tickets(root=self.root, status="approved")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["decision_note"], "do it")

    def test_move_rejects_traversal(self):
        with self.assertRaises(ValueError):
            q.move("../../etc/passwd", "approved", root=self.root)


if __name__ == "__main__":
    unittest.main(verbosity=2)
