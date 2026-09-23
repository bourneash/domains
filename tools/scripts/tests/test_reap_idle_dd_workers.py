from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "reap-idle-dd-workers.sh"


def _notification_line(marker: str) -> str:
    return next(line for line in SCRIPT.read_text(encoding="utf-8").splitlines() if marker in line)


def test_idle_reap_is_explicit_internal_info_notification():
    line = _notification_line('INTERNAL · domain-developer housekeeping')
    assert "INTERNAL" in line
    assert '"#439FE0"' in line
    assert '"warning"' not in line


def test_active_stale_image_remains_a_warning():
    line = _notification_line(':warning: ${#drifted_active[@]}')
    assert ":warning:" in line
    assert '"warning"' in line
