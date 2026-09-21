import subprocess
from pathlib import Path

import pytest

from media_gen import codex, config


def _png(width=1536, height=1024):
    # The backend only needs the PNG signature + IHDR dimensions to validate
    # the handoff; Codex itself supplies the complete payload in production.
    return b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + width.to_bytes(4, "big") + height.to_bytes(4, "big")


def test_png_dimensions():
    assert codex._png_dimensions(_png(1200, 675)) == (1200, 675)
    with pytest.raises(codex.CodexError, match="valid PNG"):
        codex._png_dimensions(b"not an image")


def test_generate_invokes_isolated_codex_and_reads_output(monkeypatch, tmp_path):
    monkeypatch.setattr(codex, "available", lambda: True)
    monkeypatch.setattr(config, "CODEX_BINARY", "/usr/bin/codex")
    monkeypatch.setattr(config, "CODEX_HOME", tmp_path / "codex-home")

    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        output = config.CODEX_HOME / "generated_images" / "session" / "result.png"
        output.parent.mkdir(parents=True)
        output.write_bytes(_png())
        return subprocess.CompletedProcess(command, 0, stdout="done", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    image, meta = codex._generate_untracked(
        "a blank brass compass", aspect_ratio="16:9", width=1200, height=675,
    )

    assert image == _png()
    assert meta["backend"] == "codex"
    assert (meta["width"], meta["height"]) == (1536, 1024)
    assert captured["command"][:3] == ["/usr/bin/codex", "exec", "--ignore-user-config"]
    assert "--approve-for-me" not in captured["command"]
    assert captured["kwargs"]["env"]["CODEX_HOME"] == str(tmp_path / "codex-home")
    assert "IMAGE DESCRIPTION BEGIN\na blank brass compass\nIMAGE DESCRIPTION END" in captured["command"][-1]
    assert "copy" not in captured["command"][-1].lower()


def test_generate_missing_output_is_error(monkeypatch, tmp_path):
    monkeypatch.setattr(codex, "available", lambda: True)
    monkeypatch.setattr(config, "CODEX_HOME", tmp_path / "codex-home")
    monkeypatch.setattr(
        subprocess, "run",
        lambda command, **kwargs: subprocess.CompletedProcess(command, 0, stdout="done", stderr=""),
    )
    with pytest.raises(codex.CodexError, match="failed"):
        codex._generate_untracked("a blank brass compass")
