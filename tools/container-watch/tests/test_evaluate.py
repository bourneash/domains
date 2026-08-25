"""Rules are tested against fixtures, never against this host's live docker.

A watchdog you cannot test is how a container sits Exited(255) for six days
without anyone noticing (B11).
"""
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from evaluate import evaluate  # noqa: E402

NOW = datetime(2026, 8, 25, 12, 0, tzinfo=timezone.utc)
CFG = {
    "thresholds": {
        "dead_after_hours": 6,
        "restart_count_warn": 5,
        "unhealthy_after_minutes": 30,
        "crashloop_window_minutes": 60,
        "benign_exit_codes": [0, 143],
    },
    "ignore": {"names": {}, "projects": {}, "images": {}},
}


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def container(**kw):
    base = {
        "name": "c1",
        "running": True,
        "exit_code": 0,
        "finished_at": None,
        "started_at": iso(NOW - timedelta(days=3)),
        "restart_count": 0,
        "restart_policy": "unless-stopped",
        "health": None,
        "health_since": None,
        "image": "img",
        "project": "proj",
    }
    base.update(kw)
    return base


def kinds(findings):
    return sorted(f["kind"] for f in findings)


# --- the B11 case ------------------------------------------------------------

def test_dead_nonzero_is_reported_regardless_of_project():
    # pia_openvpn_2's exact shape: exited 255, dead for days, outside this repo.
    c = container(
        name="pia_openvpn_2",
        running=False,
        exit_code=255,
        finished_at=iso(NOW - timedelta(days=6)),
        restart_policy="no",
        project="infra",
    )
    assert kinds(evaluate([c], CFG, NOW)) == ["dead-nonzero"]


def test_a_recent_failure_is_not_reported_yet():
    c = container(running=False, exit_code=1, finished_at=iso(NOW - timedelta(hours=1)))
    assert evaluate([c], CFG, NOW) == []


def test_a_clean_oneshot_exit_is_not_a_finding():
    c = container(running=False, exit_code=0, finished_at=iso(NOW - timedelta(days=9)),
                  restart_policy="no")
    assert evaluate([c], CFG, NOW) == []


# --- hardening: the two false positives the first live run produced ----------

def test_sigterm_exit_is_a_deliberate_stop_not_a_failure():
    # 143 == 128+SIGTERM, exactly what `docker stop` / `compose down` leaves.
    c = container(name="amazonhaulfinder-browser-1", running=False, exit_code=143,
                  finished_at=iso(NOW - timedelta(days=17)), restart_policy="no")
    assert evaluate([c], CFG, NOW) == []


def test_sigkill_exit_is_still_reported_because_the_oom_killer_uses_it():
    c = container(running=False, exit_code=137, finished_at=iso(NOW - timedelta(days=1)),
                  restart_policy="no")
    assert kinds(evaluate([c], CFG, NOW)) == ["dead-nonzero"]


def test_old_restarts_on_a_long_running_container_are_history_not_a_crashloop():
    # credential-vault: 14 cumulative restarts, but up for six days.
    c = container(name="credential-vault", restart_count=14,
                  started_at=iso(NOW - timedelta(days=6)))
    assert evaluate([c], CFG, NOW) == []


def test_a_real_crashloop_is_high_restarts_AND_a_recent_start():
    c = container(restart_count=14, started_at=iso(NOW - timedelta(minutes=3)))
    assert kinds(evaluate([c], CFG, NOW)) == ["crashloop"]


# --- the other states that look fine from a distance -------------------------

def test_stopped_despite_a_persistent_restart_policy():
    # Clean exit code, so dead-nonzero misses it — but docker gave up and it is
    # silently not running.
    c = container(running=False, exit_code=0, finished_at=iso(NOW - timedelta(days=2)),
                  restart_policy="always")
    assert kinds(evaluate([c], CFG, NOW)) == ["should-be-running"]


def test_running_but_failing_its_own_healthcheck():
    c = container(health="unhealthy", health_since=iso(NOW - timedelta(hours=2)))
    assert kinds(evaluate([c], CFG, NOW)) == ["unhealthy"]


def test_a_briefly_unhealthy_container_is_given_time_to_settle():
    c = container(health="unhealthy", health_since=iso(NOW - timedelta(minutes=5)))
    assert evaluate([c], CFG, NOW) == []


def test_healthy_and_starting_are_never_findings():
    for h in ("healthy", "starting", None):
        assert evaluate([container(health=h)], CFG, NOW) == []


# --- the ignore list ---------------------------------------------------------

def test_an_ignore_entry_silences_by_name_project_or_image():
    dead = dict(running=False, exit_code=255, finished_at=iso(NOW - timedelta(days=6)))
    for key, field, value in [
        ("names", "name", "c1"),
        ("projects", "project", "proj"),
        ("images", "image", "img"),
    ]:
        cfg = {**CFG, "ignore": {key: {value: "deliberately left dead"}}}
        assert evaluate([container(**dead)], cfg, NOW) == [], f"{key} ignore failed"


def test_an_expired_mute_stops_hiding_the_container():
    c = container(running=False, exit_code=255, finished_at=iso(NOW - timedelta(days=6)))
    live = {"ignore": {"names": {"c1": {"reason": "r", "until": "2026-12-01"}}}, **{"thresholds": CFG["thresholds"]}}
    assert evaluate([c], live, NOW) == [], "an unexpired mute should hide it"
    expired = {"ignore": {"names": {"c1": {"reason": "r", "until": "2026-08-01"}}}, **{"thresholds": CFG["thresholds"]}}
    assert kinds(evaluate([c], expired, NOW)) == ["dead-nonzero"], "an expired mute must not hide it"


# --- robustness --------------------------------------------------------------

def test_unparseable_or_missing_timestamps_never_raise():
    for bad in (None, "", "not-a-date", "0001-01-01T00:00:00Z"):
        evaluate([container(running=False, exit_code=1, finished_at=bad)], CFG, NOW)


def test_findings_are_ordered_most_severe_first():
    dead_low = container(name="z", running=False, exit_code=255,
                         finished_at=iso(NOW - timedelta(days=6)), restart_policy="no")
    unhealthy = container(name="a", health="unhealthy",
                          health_since=iso(NOW - timedelta(hours=2)))
    out = evaluate([dead_low, unhealthy], CFG, NOW)
    assert out[0]["severity"] == "high"
