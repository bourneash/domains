"""Regression tests for worker-service routing and direct-worker guards."""

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SITE = ROOT / "sites/broadwayshowgirls.com"
ROLE_MAP = SITE / "ops/scripts/role-service.sh"
WORKER = SITE / "ops/scripts/run-worker.sh"
CLAUDE_ENTRYPOINT = SITE / "ops/docker/entrypoint-worker.claude.sh"


def service_for(role: str) -> str:
    result = subprocess.run(
        ["bash", str(ROLE_MAP), role], capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def test_seo_analyst_routes_to_claude_worker():
    assert service_for("seo-analyst") == "claude-worker"
    text = WORKER.read_text(encoding="utf-8")
    assert 'SVC="$(role_service "$ROLE")"' in text
    assert 'docker compose run --rm --name "$RUN_NAME" claude-worker "$ROLE"' in text


def test_worker_roles_are_explicitly_mapped():
    assert service_for("scrape") == "worker"
    assert service_for("write-trio") == "worker"
    assert service_for("engineer") == "claude-worker"

    unknown = subprocess.run(
        ["bash", str(ROLE_MAP), "not-a-role"], capture_output=True, text=True
    )
    assert unknown.returncode != 0


def test_direct_ollama_worker_rejects_claude_roles_with_guidance():
    text = WORKER.read_text(encoding="utf-8")
    assert "belongs to claude-worker" in text
    assert 'source=role-service.sh' in text

    entrypoint = CLAUDE_ENTRYPOINT.read_text(encoding="utf-8")
    assert "source=../scripts/role-service.sh" in entrypoint
