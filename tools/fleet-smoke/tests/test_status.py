import json
import os

from lib.status import load_state, save_state, compute_status


def test_load_state_defaults_when_missing(tmp_path):
    state = load_state(str(tmp_path), "example.com")
    assert state == {"fail": 0}


def test_save_then_load_state_roundtrips(tmp_path):
    save_state(str(tmp_path), "example.com", 3, "attention")
    state = load_state(str(tmp_path), "example.com")
    assert state == {"fail": 3, "headline_word": "attention"}

    # written under a per-site filename, not clobbering other sites
    save_state(str(tmp_path), "other.com", 0, "healthy")
    assert load_state(str(tmp_path), "example.com") == {"fail": 3, "headline_word": "attention"}
    assert load_state(str(tmp_path), "other.com") == {"fail": 0, "headline_word": "healthy"}


def test_compute_status_healthy():
    icon, color, word = compute_status(fail_count=0, prev_fail_count=0)
    assert (icon, color, word) == (":white_check_mark:", "good", "healthy")


def test_compute_status_recovered():
    icon, color, word = compute_status(fail_count=0, prev_fail_count=2)
    assert (icon, color, word) == (":wrench:", "warning", "recovered")


def test_compute_status_attention():
    icon, color, word = compute_status(fail_count=1, prev_fail_count=0)
    assert (icon, color, word) == (":sos:", "danger", "attention")


def test_compute_status_still_failing_stays_attention():
    icon, color, word = compute_status(fail_count=2, prev_fail_count=2)
    assert word == "attention"
