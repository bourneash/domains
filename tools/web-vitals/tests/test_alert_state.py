import importlib.util
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "alert_state", Path(__file__).resolve().parents[1] / "alert_state.py"
)
alert_state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alert_state)


def report(*, lcp=3179, flags=("lcp_ms",), status="measured", error=None):
    return {"at": "now", "sites": [{"site": "greatamericanlakes.com", "status": status,
            "error": error, "metrics": {"performance": 0.9, "lcp_ms": lcp, "cls": 0},
            "budget_breaches": list(flags), "regressions": []}]}


def test_moderate_lcp_requires_two_measured_breaches():
    events, state = alert_state.transition(report(), {}, "mobile")
    assert events == []
    assert state["pending"]["greatamericanlakes.com"]["count"] == 1

    events, state = alert_state.transition(report(status="skipped"), state, "mobile")
    assert events == []
    assert state["pending"]["greatamericanlakes.com"]["count"] == 1

    events, state = alert_state.transition(report(), state, "mobile")
    assert [event["status"] for event in events] == ["warn"]
    assert state["active"]["greatamericanlakes.com"] == "lcp_ms"

    events, state = alert_state.transition(report(lcp=2452, flags=()), state, "mobile")
    assert [event["status"] for event in events] == ["ok"]
    assert state["active"] == {}


def test_single_spike_does_not_alert():
    _, state = alert_state.transition(report(), {}, "mobile")
    events, state = alert_state.transition(report(lcp=2452, flags=()), state, "mobile")
    assert events == []
    assert state["pending"] == {}


def test_severe_lcp_and_measurement_errors_alert_immediately():
    events, _ = alert_state.transition(report(lcp=4072), {}, "mobile")
    assert [event["status"] for event in events] == ["warn"]
    events, _ = alert_state.transition(report(error="Chrome failed"), {}, "mobile")
    assert [event["status"] for event in events] == ["warn"]
