import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
VALIDATOR = ROOT / "tools/cron-roles/validate-deployer.sh"


def make_site(tmp_path: Path, invocation: str) -> Path:
    site = tmp_path / "example.com"
    scripts = site / "ops/scripts"
    docker = site / "ops/docker"
    scripts.mkdir(parents=True)
    docker.mkdir(parents=True)
    (scripts / "run-deployer.sh").write_text(
        f"#!/usr/bin/env bash\n{invocation}\n", encoding="utf-8"
    )
    (docker / "entrypoint-worker.sh").write_text(
        "#!/usr/bin/env bash\n"
        "case \"${1:-}\" in\n"
        "  deployer) exec bash /work/ops/scripts/deploy.sh ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    return site


def run_validator(site: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(VALIDATOR), str(site)],
        text=True,
        capture_output=True,
        check=False,
    )


def test_accepts_entrypoint_preserving_dispatch(tmp_path: Path):
    result = run_validator(make_site(tmp_path, "docker compose run --rm worker deployer"))
    assert result.returncode == 0, result.stdout + result.stderr


def test_rejects_entrypoint_override(tmp_path: Path):
    site = make_site(
        tmp_path,
        "docker compose run --rm --entrypoint bash worker ops/scripts/deploy.sh",
    )
    result = run_validator(site)
    assert result.returncode == 1
    assert "overrides the worker entrypoint" in result.stderr


def test_canonical_template_and_marineactivity_are_safe():
    template = ROOT / "tools/cron-roles/archetypes/deployer/scripts/run-deployer.sh.tmpl"
    assert "--entrypoint" not in template.read_text(encoding="utf-8")

    result = run_validator(ROOT / "sites/marineactivity.com")
    assert result.returncode == 0, result.stdout + result.stderr
