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


def cls_report(*, cls=0.044, status="measured", regression=True, breach=False, extra_flags=()):
    return {"at": "now", "sites": [{
        "site": "marineactivity.com", "status": status, "error": None,
        "metrics": {
            "performance": 0.98, "lcp_ms": 1900, "cls": cls,
            "cls_culprits": [{"score": 0.044, "selector": "main > h1",
                              "causes": [{"cause": "Web font loaded"}]}],
        },
        "budget_breaches": (["cls"] if breach else []) + list(extra_flags),
        "regressions": (["cls"] if regression else []) + list(extra_flags),
    }]}


def test_in_budget_cls_regression_requires_two_successful_samples_and_reports_culprit():
    events, state = alert_state.transition(cls_report(), {}, "mobile")
    assert events == []
    assert state["active"] == {}
    assert state["pending"]["marineactivity.com"] == {"signature": "cls", "count": 1}

    events, state = alert_state.transition(cls_report(status="skipped"), state, "mobile")
    assert events == []
    assert state["pending"]["marineactivity.com"]["count"] == 1

    events, state = alert_state.transition(cls_report(), state, "mobile")
    assert [event["status"] for event in events] == ["warn"]
    assert "flags=cls" in events[0]["detail"]
    assert "main > h1" in events[0]["detail"]
    assert "Web font loaded" in events[0]["detail"]
    assert state["active"]["marineactivity.com"] == "cls"
    assert state["pending"] == {}


def test_clean_sample_resets_pending_cls_and_budget_breach_is_immediate():
    _, state = alert_state.transition(cls_report(), {}, "mobile")
    events, state = alert_state.transition(cls_report(cls=0, regression=False), state, "mobile")
    assert events == []
    assert state["pending"] == {}

    events, state = alert_state.transition(cls_report(cls=0.12, regression=False, breach=True), {}, "mobile")
    assert [event["status"] for event in events] == ["warn"]
    assert state["active"]["marineactivity.com"] == "cls"


def test_independent_flags_alert_immediately_while_cls_is_pending():
    events, state = alert_state.transition(
        cls_report(extra_flags=("performance",)), {}, "mobile"
    )
    assert [event["status"] for event in events] == ["warn"]
    assert "flags=performance" in events[0]["detail"]
    assert state["pending"]["marineactivity.com"]["signature"] == "cls"
