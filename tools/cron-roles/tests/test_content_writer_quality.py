"""Fixture tests for deterministic content-writer quality gates."""

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
QUALITY = ROOT / "tools/cron-roles/content-writer-quality.py"


def run_gate(repo: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(QUALITY), "--repo-root", str(repo)],
        capture_output=True,
        text=True,
    )


def init_repo(repo: Path) -> None:
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "test"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.com"], check=True)


def test_quality_gate_catches_schema_links_affiliates_and_banned_copy(tmp_path: Path):
    repo = tmp_path / "repo"
    (repo / "site/src/content/guides").mkdir(parents=True)
    (repo / "site/public").mkdir(parents=True)
    (repo / "site/public/_redirects").write_text("/go/known/ https://example.com 302\n", encoding="utf-8")
    content = repo / "site/src/content/guides/example.md"
    content.write_text(
        "---\n"
        "title: Example\n"
        "description: Desc\n"
        "technique: trolling\n"
        "updated: '2026-09-26'\n"
        "heroImage: /images/generated/missing.webp\n"
        "featuredProducts: [unknown]\n"
        "---\n"
        "This is the perfect choice — see [missing](/guides/nope/) and /go/unknown/.\n",
        encoding="utf-8",
    )
    init_repo(repo)
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-qm", "seed"], check=True)
    content.write_text(content.read_text(encoding="utf-8").replace("Desc", "Changed"), encoding="utf-8")

    result = run_gate(repo)
    assert result.returncode == 1
    assert "heroImage does not exist" in result.stderr
    assert "unknown affiliate id" in result.stderr
    assert "banned phrase" in result.stderr
    assert "internal link does not resolve" in result.stderr


def test_quality_gate_accepts_valid_changed_content(tmp_path: Path):
    repo = tmp_path / "repo"
    (repo / "site/src/content/guides").mkdir(parents=True)
    (repo / "site/public/images/generated").mkdir(parents=True)
    (repo / "site/public/images/generated/hero.webp").write_bytes(b"image")
    (repo / "site/public/_redirects").write_text("/go/known/ https://example.com 302\n", encoding="utf-8")
    content = repo / "site/src/content/guides/example.md"
    content.write_text(
        "---\n"
        "title: Example\n"
        "description: Desc\n"
        "technique: trolling\n"
        "updated: '2026-09-26'\n"
        "heroImage: /images/generated/hero.webp\n"
        "featuredProducts: [known]\n"
        "---\n"
        "Run the rig hard.\n",
        encoding="utf-8",
    )
    init_repo(repo)
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-qm", "seed"], check=True)
    content.write_text(content.read_text(encoding="utf-8").replace("Desc", "Updated"), encoding="utf-8")

    result = run_gate(repo)
    assert result.returncode == 0, result.stderr
