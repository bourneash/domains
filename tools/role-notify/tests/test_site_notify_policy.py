"""Fleet contract checks for the per-site Slack delegators and canonical sender."""

from pathlib import Path


ROOT = Path(__file__).parents[3]


def notify_scripts():
    return sorted(ROOT.glob("sites/*/ops/scripts/notify-slack.sh"))


def canonical_script():
    return (ROOT / "tools" / "scripts" / "notify-slack.sh").read_text(encoding="utf-8")


def test_every_site_wrapper_has_the_quiet_success_gate():
    scripts = notify_scripts()
    assert scripts, "expected per-site Slack wrappers"
    canonical = canonical_script()
    assert '${SLACK_VERBOSE:-}' in canonical
    assert '[[ "$SEVERITY" == "info" ]] && exit 0' in canonical
    for script in scripts:
        text = script.read_text(encoding="utf-8")
        assert 'exec "$CANONICAL" "$@"' in text, script


def test_quiet_gate_precedes_disk_log_and_slack_post():
    canonical = canonical_script()
    for script in notify_scripts():
        text = script.read_text(encoding="utf-8")
        gate = canonical.index('[[ "$SEVERITY" == "info" ]] && exit 0')
        first_side_effect = min(
            index for index in (canonical.find("log_to_disk", gate), canonical.find("log_file=", gate))
            if index >= 0
        )
        assert gate < first_side_effect
        assert gate < canonical.index("SLACK_BOT_TOKEN", gate)
        assert 'exec "$CANONICAL" "$@"' in text, script
