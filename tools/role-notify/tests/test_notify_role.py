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
