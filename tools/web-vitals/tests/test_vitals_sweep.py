import importlib.util
import json
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "vitals-sweep.py"
SPEC = importlib.util.spec_from_file_location("vitals_sweep", MODULE_PATH)
vitals = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(vitals)


def test_access_gated_sites_are_exposed_separately(tmp_path):
    registry = tmp_path / "fleet.yaml"
    registry.write_text(
        "sites:\n"
        "  gated.example:\n"
        "    status: live\n"
        "    access_gated: true\n"
        "  open.example:\n"
        "    status: live\n",
        encoding="utf-8",
    )
    old = vitals.REGISTRY
    vitals.REGISTRY = registry
    try:
        assert vitals.load_site_sets(None) == (["open.example"], {"gated.example"})
        assert vitals.load_live_sites(["gated.example"]) == []
    finally:
        vitals.REGISTRY = old


class _Response:
    def __init__(self, body):
        self.body = body.encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return self.body


def test_gate_probe_distinguishes_gated_open_and_unverified(monkeypatch):
    monkeypatch.setattr(
        vitals,
        "urlopen",
        lambda *_args, **_kwargs: _Response('<span>Private Preview</span><input type="password">'),
    )
    assert vitals.probe_access_gate("gated.example")[0] == "gated"

    monkeypatch.setattr(vitals, "urlopen", lambda *_args, **_kwargs: _Response("<h1>Live site</h1>"))
    assert vitals.probe_access_gate("open.example")[0] == "open"

    def fail(*_args, **_kwargs):
        raise OSError("offline")

    monkeypatch.setattr(vitals, "urlopen", fail)
    assert vitals.probe_access_gate("unknown.example")[0] == "unverified"


def test_skipped_rows_are_reported_but_not_added_to_history(tmp_path):
    reports = tmp_path / "reports"
    reports.mkdir()
    old = vitals.REPORTS
    vitals.REPORTS = reports
    payload = {
        "at": "2026-09-22T12:00:00+0000",
        "form_factor": "mobile",
        "budgets": {},
        "totals": {"sites": 2, "errors": 0, "skipped": 1, "warnings": 0},
        "sites": [
            {"site": "gated.example", "status": "skipped", "error": None, "reason": "access_gated", "warnings": []},
            {"site": "open.example", "status": "measured", "error": None, "metrics": {
                "performance": 1, "accessibility": 1, "lcp_ms": 1, "cls": 0, "tbt_ms": 1, "a11y_failures": [],
            }, "budget_breaches": [], "regressions": [], "warnings": []},
        ],
    }
    try:
        vitals.write_reports(payload, partial=False)
        report = json.loads((reports / "latest-mobile.json").read_text())
        history = (reports / "history.jsonl").read_text().splitlines()
        assert report["sites"][0]["status"] == "skipped"
        assert len(history) == 1
        assert json.loads(history[0])["site"] == "open.example"
    finally:
        vitals.REPORTS = old
