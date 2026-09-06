import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "tools" / "social-controller" / "controller.py"
RUNNER = REPO / "tools" / "social-controller" / "run.sh"
HUB_SRC = REPO / "tools" / "social-hub" / "src"


@pytest.fixture()
def fleet(tmp_path, monkeypatch):
    site = tmp_path / "sites" / "satire.test"
    (site / "ops" / "social").mkdir(parents=True)
    (site / "ops" / "roles").mkdir(parents=True)
    (site / "ops" / "social" / "hub.yaml").write_text(
        "enabled: true\nplatforms: [bluesky, console]\napproval: manual\n"
        "voice: Explicit satire, not an adult site.\n"
    )
    (site / "ops" / "roles" / "promoter.md").write_text("# Promoter\n")
    db_file = tmp_path / "hub.db"
    monkeypatch.setenv("FLEET_DOMAINS_ROOT", str(tmp_path))
    monkeypatch.setenv("SOCIAL_HUB_DB", str(db_file))
    sys.path.insert(0, str(HUB_SRC))
    from social_hub import db

    db.reset_connections()
    db.connect()
    yield tmp_path, db
    db.reset_connections()


def _run(fleet_root, db_file, *args):
    env = {
        **os.environ,
        "FLEET_DOMAINS_ROOT": str(fleet_root),
        "DOMAINS_ROOT": str(fleet_root),
        "SOCIAL_HUB_DB": str(db_file),
        "PYTHONPATH": str(HUB_SRC),
    }
    return subprocess.run(
        [sys.executable, str(SCRIPT), *map(str, args)],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def _post(db, *, platform="bluesky", status="draft"):
    now = db.utcnow()
    return db.insert(
        "posts",
        {
            "site": "satire.test",
            "platform": platform,
            "kind": "post",
            "status": status,
            "body": "A sharp, on-brand line.",
            "created_at": now,
            "updated_at": now,
        },
    )


def test_prepare_discovers_site_context_and_excludes_console(fleet, tmp_path):
    root, db = fleet
    public_id = _post(db)
    _post(db, platform="console")
    packet = tmp_path / "packet.json"

    result = _run(root, db.db_path(), "prepare", "--output", packet)

    assert result.returncode == 0
    assert result.stdout.strip() == "1"
    payload = json.loads(packet.read_text())
    assert [post["id"] for post in payload["posts"]] == [public_id]
    assert payload["sites"][0]["voice"].startswith("Explicit satire")
    assert payload["sites"][0]["writer_role_paths"] == [
        "sites/satire.test/ops/roles/promoter.md"
    ]


def test_decisions_are_guarded_and_audited(fleet, tmp_path):
    root, db = fleet
    approved = _post(db)
    rejected = _post(db)
    console = _post(db, platform="console")

    assert _run(root, db.db_path(), "approve", approved).returncode == 0
    result = _run(root, db.db_path(), "reject", rejected, "--reason", "Wrong tone for this satire brand")
    assert result.returncode == 0
    assert db.one("SELECT approved_by FROM posts WHERE id = ?", (approved,))[0] == "social-controller"
    assert db.one("SELECT approved_by FROM posts WHERE id = ?", (rejected,))[0] == "social-controller"
    assert db.one("SELECT status FROM posts WHERE id = ?", (rejected,))[0] == "needs_rewrite"
    assert db.one("SELECT category FROM feedback WHERE post_id = ?", (rejected,))[0] == "other"
    assert _run(root, db.db_path(), "approve", console).returncode != 0
    assert _run(root, db.db_path(), "approve", approved).returncode != 0


def test_runner_never_invokes_ai_for_an_empty_queue(fleet, tmp_path):
    root, db = fleet
    marker = tmp_path / "ai-was-called"
    fake = tmp_path / "fake-claude"
    fake.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 99\n")
    fake.chmod(0o755)
    env = {
        **os.environ,
        "FLEET_DOMAINS_ROOT": str(root),
        "DOMAINS_ROOT": str(root),
        "SOCIAL_HUB_DB": str(db.db_path()),
        "SOCIAL_CONTROLLER_TOOL_DIR": str(REPO / "tools" / "social-controller"),
        "SOCIAL_CONTROLLER_DATA_DIR": str(tmp_path / "runtime"),
        "SOCIAL_CONTROLLER_CLAUDE_TRACKED": str(fake),
        "PYTHONPATH": str(HUB_SRC),
    }

    result = subprocess.run(["bash", str(RUNNER)], env=env, text=True, capture_output=True)

    assert result.returncode == 0
    assert not marker.exists()
