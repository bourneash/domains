"""Fleet contract checks for the copied per-site Slack wrappers."""

from pathlib import Path


ROOT = Path(__file__).parents[3]


def notify_scripts():
    return sorted(ROOT.glob("sites/*/ops/scripts/notify-slack.sh"))


def test_every_site_wrapper_has_the_quiet_success_gate():
    scripts = notify_scripts()
    assert scripts, "expected per-site Slack wrappers"
    for script in scripts:
        text = script.read_text(encoding="utf-8")
        assert '${SLACK_VERBOSE:-}' in text, script
        assert '[[ "$SEVERITY" == "info" ]] && exit 0' in text, script


def test_quiet_gate_precedes_disk_log_and_slack_post():
    for script in notify_scripts():
        text = script.read_text(encoding="utf-8")
        gate = text.index('[[ "$SEVERITY" == "info" ]] && exit 0')
        first_side_effect = min(
            index for index in (text.find("log_to_disk"), text.find("log_file="))
            if index >= 0
        )
        assert gate < first_side_effect, script
        assert gate < text.index("SLACK_BOT_TOKEN", gate), script
