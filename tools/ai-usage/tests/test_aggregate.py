import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "aggregate.py"
SPEC = importlib.util.spec_from_file_location("aggregate", MODULE_PATH)
aggregate = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(aggregate)


def record(**overrides):
    base = {
        "site": "example.com",
        "role": "engineer",
        "model": "claude-sonnet-5",
        "subtype": "success",
        "is_error": False,
        "exit_status": 0,
        "input_tokens": 10,
        "output_tokens": 20,
        "cache_creation_input_tokens": 5,
        "cache_read_input_tokens": 90,
        "total_cost_usd": 0.5,
    }
    base.update(overrides)
    return base


class AggregateTests(unittest.TestCase):
    def root(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        return Path(tmp.name)

    def write_ledger(self, root, site, day, records):
        log_dir = root / "sites" / site / "ops" / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        path = log_dir / f"token-usage-{day}.jsonl"
        with path.open("a", encoding="utf-8") as fh:
            for rec in records:
                fh.write(json.dumps(rec) + "\n")

    def test_uninstrumented_site_reports_zero_not_error(self):
        root = self.root()
        (root / "sites" / "no-ledger.com").mkdir(parents=True)
        (root / "sites" / "instrumented.com" / "ops" / "logs").mkdir(parents=True)
        self.write_ledger(root, "instrumented.com", "2026-07-29", [record(site="instrumented.com")])

        report = aggregate.collect(root)

        self.assertEqual(report["summary"]["sites_total"], 2)
        self.assertEqual(report["summary"]["sites_instrumented"], 1)
        self.assertIn("no-ledger.com", report["summary"]["sites_uninstrumented"])

    def test_aggregates_by_site_role_and_day(self):
        root = self.root()
        self.write_ledger(root, "example.com", "2026-07-29", [
            record(role="engineer", input_tokens=10, output_tokens=20, total_cost_usd=0.5),
            record(role="watchdog", input_tokens=5, output_tokens=5, total_cost_usd=0.1),
        ])
        self.write_ledger(root, "example.com", "2026-07-30", [
            record(role="engineer", input_tokens=1, output_tokens=1, total_cost_usd=0.01),
        ])

        report = aggregate.collect(root)

        site_row = next(r for r in report["by_site"] if r["site"] == "example.com")
        self.assertEqual(site_row["calls"], 3)
        self.assertAlmostEqual(site_row["total_cost_usd"], 0.61)

        engineer_row = next(
            r for r in report["by_site_role"]
            if r["site"] == "example.com" and r["role"] == "engineer"
        )
        self.assertEqual(engineer_row["calls"], 2)
        self.assertEqual(engineer_row["input_tokens"], 11)

        days = {r["day"]: r["calls"] for r in report["by_day"]}
        self.assertEqual(days["2026-07-29"], 2)
        self.assertEqual(days["2026-07-30"], 1)

    def test_malformed_lines_are_skipped_not_fatal(self):
        root = self.root()
        log_dir = root / "sites" / "example.com" / "ops" / "logs"
        log_dir.mkdir(parents=True)
        path = log_dir / "token-usage-2026-07-29.jsonl"
        path.write_text('{"site": "example.com", "role": "engineer", "input_tokens": 1}\nnot json\n')

        report = aggregate.collect(root)

        self.assertEqual(report["summary"]["calls"], 1)

    def test_cache_hit_ratio_none_when_no_tokens(self):
        totals = aggregate._empty_totals()
        self.assertIsNone(aggregate._cache_hit_ratio(totals))

    def test_errors_counted_separately_from_calls(self):
        root = self.root()
        self.write_ledger(root, "example.com", "2026-07-29", [
            record(is_error=False),
            record(is_error=True, subtype="parse_error", input_tokens=None, output_tokens=None,
                   cache_creation_input_tokens=None, cache_read_input_tokens=None, total_cost_usd=None),
        ])

        report = aggregate.collect(root)

        site_row = report["by_site"][0]
        self.assertEqual(site_row["calls"], 2)
        self.assertEqual(site_row["errors"], 1)
        # None fields from a parse_error record must not crash summation
        self.assertEqual(site_row["input_tokens"], 10)


if __name__ == "__main__":
    unittest.main()
