"""Notification policy tests for the shared role-completion notifier."""

from __future__ import annotations

import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "notify_role.py"
SPEC = importlib.util.spec_from_file_location("notify_role", MODULE_PATH)
notify_role = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(notify_role)


def test_success_is_quiet_by_default():
    assert notify_role.verbose_success_enabled({}) is False


def test_slack_verbose_restores_success_messages():
    assert notify_role.verbose_success_enabled({"SLACK_VERBOSE": "1"}) is True
    assert notify_role.verbose_success_enabled({"SLACK_VERBOSE": "true"}) is True


def test_legacy_loud_flag_remains_supported():
    assert notify_role.verbose_success_enabled({"NOTIFY_ROLE_LOUD_OK": "1"}) is True


def test_false_values_do_not_enable_verbose_mode():
    assert notify_role.verbose_success_enabled({"SLACK_VERBOSE": "0"}) is False
    assert notify_role.verbose_success_enabled({"SLACK_VERBOSE": "false"}) is False


def test_failures_and_warnings_are_never_suppressed():
    assert notify_role.should_post("fail", {}) is True
    assert notify_role.should_post("warn", {}) is True
    assert notify_role.should_post("ok", {}) is False


def test_turn_cap_failure_log_becomes_actionable(tmp_path):
    log = tmp_path / "content-writer.log"
    log.write_text(
        "claude-tracked.sh: FAILURE REASON — hit its turn cap (17/16) — "
        "the run was truncated, NOT a crash. "
        "(site=reviewtattoo.com role=content-writer class=execution_failure "
        "subtype=error_max_turns turns=17 exit=1)\n"
    )
    headline, details = notify_role.extract_failure_from_log(str(log))
    assert headline == "Stopped at the turn limit after 17 turns; work was interrupted, not crashed"
    assert details[0].startswith("Next step:")
    assert "do not blindly raise the cap" in details[1]


def test_unknown_failure_log_keeps_wrapper_reason(tmp_path):
    log = tmp_path / "writer.log"
    log.write_text(
        "claude-tracked.sh: FAILURE REASON — the model errored mid-run. "
        "(site=x.test role=writer class=execution_failure "
        "subtype=error_during_execution turns=3 exit=1)\n"
    )
    headline, details = notify_role.extract_failure_from_log(str(log))
    assert headline == "Role failed: error_during_execution"
    assert details == ["the model errored mid-run."]
