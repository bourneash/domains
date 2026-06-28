import threading
import time
from pathlib import Path
import pytest
from social_lib.browser_session import cloak_args, gate_wait, gate_continue, GATE_DIR


def test_cloak_args_includes_proxy():
    args = cloak_args("us")
    assert any("127.0.0.1:8181" in a for a in args)


def test_cloak_args_eu_proxy():
    args = cloak_args("eu")
    assert any("127.0.0.1:8182" in a for a in args)


def test_gate_wait_unblocks_on_continue(tmp_path, monkeypatch):
    monkeypatch.setattr("social_lib.browser_session.GATE_DIR", tmp_path)

    def signal():
        time.sleep(0.2)
        gate_continue.__wrapped__ = None  # ensure we test through the module
        (tmp_path / "mygate.continue").write_text("")

    t = threading.Thread(target=signal)
    t.start()
    gate_wait("mygate", "Please do something")
    t.join()
    assert not (tmp_path / "mygate.waiting").exists()
