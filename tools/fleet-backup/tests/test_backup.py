"""fleet-backup tests.

The one that matters: `never` is an ABORT, not a filter. A backup tool that
quietly skips a credential file and reports success is how a fleet's secrets
end up in an offsite bucket nobody audits.
"""
import importlib.util
import io
import sys
import tarfile
from pathlib import Path

import pytest

MODULE = Path(__file__).resolve().parents[1] / "backup.py"
spec = importlib.util.spec_from_file_location("fleet_backup", MODULE)
fb = importlib.util.module_from_spec(spec)
sys.modules["fleet_backup"] = fb
spec.loader.exec_module(fb)

NEVER = [".env", ".env.shared", "tools/env-broker/rendered", ".credentials.json"]


# --- the secret guard --------------------------------------------------------

@pytest.mark.parametrize("rel", [
    ".env",
    "tools/env-broker/rendered/xxxtea.com.env",
    "sites/xxxtea.com/.env.shared",
    "somewhere/.credentials.json",
])
def test_secrets_abort_the_run(rel):
    with pytest.raises(fb.SecretInArchive):
        fb.assert_no_secret(rel, NEVER)


@pytest.mark.parametrize("rel", [
    "tools/env-broker/policy.yaml",     # the allowlist is not a secret
    "registry/fleet.yaml",
    "tools/cf-stats/out/cf-stats-2026-08-25.jsonl",
])
def test_ordinary_paths_pass(rel):
    fb.assert_no_secret(rel, NEVER)


def test_collect_aborts_rather_than_skipping(tmp_path, monkeypatch):
    monkeypatch.setattr(fb, "ROOT", tmp_path)
    d = tmp_path / "group"
    d.mkdir()
    (d / "fine.txt").write_text("ok")
    (d / ".env").write_text("SECRET=1")
    with pytest.raises(fb.SecretInArchive):
        fb.collect(["group"], None, NEVER)


# --- collection --------------------------------------------------------------

def test_collect_walks_directories_and_takes_files(tmp_path, monkeypatch):
    monkeypatch.setattr(fb, "ROOT", tmp_path)
    (tmp_path / "g" / "sub").mkdir(parents=True)
    (tmp_path / "g" / "a.txt").write_text("a")
    (tmp_path / "g" / "sub" / "b.txt").write_text("b")
    rels = sorted(r for _, r in fb.collect(["g"], None, NEVER))
    assert rels == ["g/a.txt", "g/sub/b.txt"]


def test_collect_missing_path_is_not_an_error(tmp_path, monkeypatch):
    monkeypatch.setattr(fb, "ROOT", tmp_path)
    assert fb.collect(["nope"], None, NEVER) == []


def test_incremental_skips_files_older_than_the_last_run(tmp_path, monkeypatch):
    monkeypatch.setattr(fb, "ROOT", tmp_path)
    d = tmp_path / "g"
    d.mkdir()
    old, new = d / "old.txt", d / "new.txt"
    old.write_text("old")
    new.write_text("new")
    import os
    os.utime(old, (1000, 1000))
    os.utime(new, (9000, 9000))
    rels = [r for _, r in fb.collect(["g"], 5000, NEVER)]
    assert rels == ["g/new.txt"]


# --- archives ----------------------------------------------------------------

def test_archive_round_trips_with_repo_relative_names(tmp_path, monkeypatch):
    monkeypatch.setattr(fb, "ROOT", tmp_path)
    d = tmp_path / "g"
    d.mkdir()
    (d / "a.txt").write_text("hello")
    spool, digest, size = fb.make_archive(fb.collect(["g"], None, NEVER))
    assert len(digest) == 64
    assert size > 0
    with spool, tarfile.open(fileobj=spool, mode="r:gz") as tar:
        assert tar.getnames() == ["g/a.txt"]
        assert tar.extractfile("g/a.txt").read() == b"hello"


def test_archive_is_spooled_to_disk_not_memory(tmp_path, monkeypatch):
    """data-hub-images' volume is 1.8 GB; an in-memory tarball took this
    process to 3.8 GB RSS on a host running 200+ containers."""
    monkeypatch.setattr(fb, "ROOT", tmp_path)
    d = tmp_path / "g"
    d.mkdir()
    (d / "a.txt").write_text("hello")
    spool, _, _ = fb.make_archive(fb.collect(["g"], None, NEVER))
    with spool:
        assert hasattr(spool, "fileno"), "archive must be a real file, not BytesIO"
        assert spool.tell() == 0, "spool must be rewound and ready to upload"


def test_archive_digest_changes_with_content(tmp_path, monkeypatch):
    monkeypatch.setattr(fb, "ROOT", tmp_path)
    d = tmp_path / "g"
    d.mkdir()
    f = d / "a.txt"
    f.write_text("one")
    s1, first, _ = fb.make_archive(fb.collect(["g"], None, NEVER))
    s1.close()
    f.write_text("two")
    s2, second, _ = fb.make_archive(fb.collect(["g"], None, NEVER))
    s2.close()
    assert first != second


# --- restore safety ----------------------------------------------------------

def test_restore_refuses_to_overwrite_the_live_repo(monkeypatch, capsys):
    monkeypatch.setattr(fb, "client", lambda: (_ for _ in ()).throw(
        AssertionError("must refuse before touching the network")))
    args = type("A", (), {"restore": "registry", "into": str(fb.ROOT)})()
    # The guard must trip before any client is constructed.
    with pytest.raises(AssertionError):
        fb.cmd_restore(args, {"destination": {"bucket": "b", "prefix": "p"}})


# --- manifest ----------------------------------------------------------------

def test_shipped_manifest_never_list_covers_the_obvious_secrets():
    m = fb.load_manifest()
    for must in (".env", "tools/env-broker/rendered"):
        assert must in m["never"], f"{must} missing from the never list"


def test_shipped_manifest_does_not_back_up_rendered_credentials():
    m = fb.load_manifest()
    for group in m["groups"].values():
        for p in group.get("paths", []):
            assert "env-broker/rendered" not in p
            assert not p.endswith(".env")
