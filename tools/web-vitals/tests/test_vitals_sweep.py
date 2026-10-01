import importlib.util
import json
import signal
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


def test_stop_chrome_tolerates_process_that_ignores_forced_shutdown(monkeypatch):
    class StubbornProcess:
        pid = 1234

        def poll(self):
            return None

        def wait(self, timeout):
            raise vitals.subprocess.TimeoutExpired("chrome", timeout)

        def terminate(self):
            pass

        def kill(self):
            pass

    signals = []
    monkeypatch.setattr(vitals.os, "killpg", lambda pid, sig: signals.append((pid, sig)))
    vitals.stop_chrome(StubbornProcess())
    assert signals == [(1234, signal.SIGTERM), (1234, signal.SIGKILL)]


def test_tbt_noise_does_not_flag_good_mobile_run_as_regression():
    assert vitals.regressions(
        {"tbt_ms": 165},
        {"tbt_ms": 0},
    ) == []
    assert vitals.regressions(
        {"tbt_ms": 300},
        {"tbt_ms": 0},
    ) == ["tbt_ms"]


def test_extract_preserves_compact_layout_shift_evidence():
    extracted = vitals.extract({
        "categories": {
            "performance": {"score": 0.98},
            "accessibility": {"score": 0.96, "auditRefs": []},
        },
        "audits": {
            "largest-contentful-paint": {"numericValue": 1900},
            "cumulative-layout-shift": {"numericValue": 0.0441},
            "total-blocking-time": {"numericValue": 5},
            "layout-shifts": {"details": {"items": [{
                "score": 0.0441,
                "node": {"selector": "main > h1", "snippet": "<h1>Marine Activity</h1>"},
                "subItems": {"items": [{
                    "cause": {"type": "text", "value": "Web font loaded"},
                    "extra": {"type": "url", "value": "https://fonts.example/font.woff2"},
                }]},
            }]}},
        },
    })

    assert extracted["cls"] == 0.0441
    assert extracted["cls_culprits"] == [{
        "score": 0.0441,
        "selector": "main > h1",
        "snippet": "<h1>Marine Activity</h1>",
        "causes": [{"cause": "Web font loaded", "resource": "https://fonts.example/font.woff2"}],
    }]


def test_extract_caps_layout_shift_evidence_and_handles_missing_audit():
    items = [{"score": score, "node": {"selector": f".shift-{score}"}} for score in range(7)]
    extracted = vitals.extract({"categories": {}, "audits": {
        "layout-shifts": {"details": {"items": items}},
    }})
    assert len(extracted["cls_culprits"]) == 5
    assert vitals.extract({"categories": {}, "audits": {}})["cls_culprits"] == []


def test_lighthouse_retries_timeouts_with_exponential_backoff(monkeypatch):
    monkeypatch.setenv("VITALS_SITE_RETRIES", "2")
    monkeypatch.setenv("VITALS_RETRY_BACKOFF_SEC", "1")
    monkeypatch.setattr(vitals, "chrome_path", lambda: "/fake/chrome")
    monkeypatch.setattr(vitals, "start_chrome", lambda *_args: (None, 1234, None))
    monkeypatch.setattr(vitals, "stop_chrome", lambda _proc: None)

    calls = []
    sleeps = []

    def timeout(*_args, **_kwargs):
        calls.append(True)
        raise vitals.subprocess.TimeoutExpired("lighthouse", 180)

    monkeypatch.setattr(vitals.subprocess, "run", timeout)
    monkeypatch.setattr(vitals.time, "sleep", lambda seconds: sleeps.append(seconds))

    report, error = vitals.run_lighthouse("https://example.com", mobile=True, timeout=180)

    assert report is None
    assert error == "lighthouse timed out after 180s after 3 attempts"
    assert len(calls) == 3
    assert sleeps == [1, 2]
