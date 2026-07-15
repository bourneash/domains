import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import state  # noqa: E402

CHECKS = {
    "oos_grace_runs": 2,
    "dead_grace_runs": 1,
    "broken_redirect_grace_runs": 1,
    "no_prime_grace_runs": 2,
    "low_rating_grace_runs": 2,
}


def test_load_state_missing_file_returns_empty_dict():
    site_dir = Path(tempfile.mkdtemp())
    assert state.load_state(site_dir) == {}


def test_save_then_load_roundtrip():
    site_dir = Path(tempfile.mkdtemp())
    state.save_state(site_dir, {"widget": {"issue": "oos", "consecutive_runs": 1}})
    assert state.load_state(site_dir)["widget"]["consecutive_runs"] == 1


def test_dead_is_actionable_immediately():
    new_state, actionable = state.update_state({}, "widget", "dead", "2026-07-15", CHECKS)
    assert actionable is True
    assert new_state["widget"]["consecutive_runs"] == 1
    assert new_state["widget"]["issue"] == "dead"
    assert new_state["widget"]["first_seen"] == "2026-07-15"


def test_oos_needs_two_consecutive_runs():
    s1, actionable1 = state.update_state({}, "widget", "oos", "2026-07-01", CHECKS)
    assert actionable1 is False
    assert s1["widget"]["consecutive_runs"] == 1

    s2, actionable2 = state.update_state(s1, "widget", "oos", "2026-07-08", CHECKS)
    assert actionable2 is True
    assert s2["widget"]["consecutive_runs"] == 2
    assert s2["widget"]["first_seen"] == "2026-07-01"
    assert s2["widget"]["last_checked"] == "2026-07-08"


def test_ok_clears_prior_issue():
    s1, _ = state.update_state({}, "widget", "oos", "2026-07-01", CHECKS)
    s2, actionable = state.update_state(s1, "widget", "ok", "2026-07-08", CHECKS)
    assert actionable is False
    assert "widget" not in s2


def test_inconclusive_leaves_existing_progress_untouched():
    s1, _ = state.update_state({}, "widget", "oos", "2026-07-01", CHECKS)
    s2, actionable = state.update_state(s1, "widget", "inconclusive", "2026-07-08", CHECKS)
    assert actionable is False
    assert s2["widget"]["consecutive_runs"] == 1
    assert s2["widget"]["last_checked"] == "2026-07-01"


def test_issue_type_change_resets_streak():
    s1, _ = state.update_state({}, "widget", "oos", "2026-07-01", CHECKS)
    s2, actionable = state.update_state(s1, "widget", "dead", "2026-07-08", CHECKS)
    assert actionable is True  # dead_grace_runs == 1
    assert s2["widget"]["issue"] == "dead"
    assert s2["widget"]["consecutive_runs"] == 1
    assert s2["widget"]["first_seen"] == "2026-07-08"
