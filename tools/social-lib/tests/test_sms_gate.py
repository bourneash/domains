import threading
import time
from pathlib import Path
import pytest
from social_lib.sms_gate import MANUAL_NUMBER, manual_gate, smspool_gate

GATE_DIR = Path("/tmp/cloak-gates")


def test_manual_number_is_jesse():
    assert MANUAL_NUMBER == "6107378479"


def test_manual_gate_returns_code(tmp_path, monkeypatch):
    monkeypatch.setattr("social_lib.sms_gate.GATE_DIR", tmp_path)

    def write_code_after_delay():
        time.sleep(0.2)
        (tmp_path / "test-gate.continue").write_text("987654")

    t = threading.Thread(target=write_code_after_delay)
    t.start()
    code = manual_gate("test-gate", number="5550001234")
    t.join()
    assert code == "987654"


def test_manual_gate_cleans_up(tmp_path, monkeypatch):
    monkeypatch.setattr("social_lib.sms_gate.GATE_DIR", tmp_path)

    def write_code():
        time.sleep(0.1)
        (tmp_path / "cleanup-gate.continue").write_text("111222")

    t = threading.Thread(target=write_code)
    t.start()
    manual_gate("cleanup-gate")
    t.join()
    assert not (tmp_path / "cleanup-gate.waiting").exists()
    assert not (tmp_path / "cleanup-gate.continue").exists()


def test_smspool_gate_raises_not_implemented():
    with pytest.raises(NotImplementedError):
        smspool_gate("instagram", "some-gate")
