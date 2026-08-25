"""Archive extraction must refuse members that escape the destination.

Restore is the one path where a tampered or corrupted archive becomes an
arbitrary file write as whoever runs it — and it runs exactly when someone is
already having a bad day. Flagged by security review 2026-08-25.

Every case goes through `backup._safe_extract`, the function backup.py actually
calls. Testing `tarfile.extractall(..., filter="data")` directly would be
testing CPython rather than this tool, and would keep passing if the call site
ever lost its guard.
"""
import importlib.util
import io
import pathlib
import sys
import tarfile

import pytest

MODULE = pathlib.Path(__file__).resolve().parents[1] / "backup.py"
spec = importlib.util.spec_from_file_location("fleet_backup_safety", MODULE)
fb = importlib.util.module_from_spec(spec)
sys.modules.setdefault("fleet_backup_safety", fb)
spec.loader.exec_module(fb)


def _tar(members):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        for name, kind, payload in members:
            ti = tarfile.TarInfo(name)
            if kind == "sym":
                ti.type = tarfile.SYMTYPE
                ti.linkname = payload
                t.addfile(ti)
            else:
                data = payload.encode()
                ti.size = len(data)
                t.addfile(ti, io.BytesIO(data))
    buf.seek(0)
    return buf


def test_parent_traversal_is_refused(tmp_path):
    dest = tmp_path / "out"
    with tarfile.open(fileobj=_tar([("../escaped.txt", "file", "pwned")]), mode="r:gz") as t:
        with pytest.raises(Exception):
            fb._safe_extract(t, dest)
    assert not (tmp_path / "escaped.txt").exists()


def test_absolute_path_is_relocated_not_written_to_root(tmp_path):
    """The guard strips the leading "/" rather than raising.

    The security property is "nothing lands outside dest", not "it raises" —
    asserting a raise here would be testing the wrong thing.
    """
    dest = tmp_path / "out"
    with tarfile.open(fileobj=_tar([("/tmp/abs-escaped.txt", "file", "pwned")]),
                      mode="r:gz") as t:
        fb._safe_extract(t, dest)
    assert (dest / "tmp" / "abs-escaped.txt").read_text() == "pwned"
    assert not pathlib.Path("/tmp/abs-escaped.txt").exists()


def test_symlink_out_of_tree_is_refused(tmp_path):
    dest = tmp_path / "out"
    with tarfile.open(fileobj=_tar([("link", "sym", "/etc/passwd")]), mode="r:gz") as t:
        with pytest.raises(Exception):
            fb._safe_extract(t, dest)
    assert not (dest / "link").exists()


def test_ordinary_archive_still_extracts(tmp_path):
    """The guard must not break real backups — internal symlinks are fine."""
    dest = tmp_path / "out"
    members = [("a.txt", "file", "ok"), ("sub/b.txt", "file", "ok"),
               ("inner-link", "sym", "a.txt")]
    with tarfile.open(fileobj=_tar(members), mode="r:gz") as t:
        fb._safe_extract(t, dest)
    assert (dest / "a.txt").read_text() == "ok"
    assert (dest / "sub" / "b.txt").read_text() == "ok"
    assert (dest / "inner-link").is_symlink()
