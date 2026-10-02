import re
import subprocess
from pathlib import Path

import pytest


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
    (scripts / "deploy.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    (docker / "crontab.docker").write_text(
        "*/5 * * * * bash ops/scripts/run-deployer.sh\n", encoding="utf-8"
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


@pytest.mark.parametrize("invocation", [
    "docker compose run --rm worker deployer",
    "docker compose run --rm --name deploy-worker worker deployer",
    "docker compose run --rm \\\n  worker deployer",
    "docker\tcompose\trun --rm worker deployer # preserve entrypoint",
    "# docker compose run --rm --entrypoint bash worker deployer\n"
    "docker compose run --rm worker deployer",
    "docker compose run --rm worker deployer # --entrypoint bash worker",
])
def test_accepts_entrypoint_preserving_dispatch(tmp_path: Path, invocation: str):
    result = run_validator(make_site(tmp_path, invocation))
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("invocation", [
    "docker compose run --rm --entrypoint bash worker ops/scripts/deploy.sh",
    "docker compose run --rm --entrypoint=bash worker deployer",
    "docker compose run --rm \\\n  --entrypoint bash worker deployer",
    "true; docker compose run --rm --entrypoint bash worker deployer",
    "true && docker compose run --rm --entrypoint bash worker deployer",
    "false || docker compose run --rm --entrypoint bash worker deployer",
    "docker compose run --rm worker deployer\n"
    "docker compose run --rm --entrypoint bash worker deployer",
])
def test_rejects_entrypoint_override(tmp_path: Path, invocation: str):
    site = make_site(
        tmp_path,
        invocation,
    )
    result = run_validator(site)
    assert result.returncode == 1
    assert "overrides the worker entrypoint" in result.stderr


def test_rejects_missing_deploy_script(tmp_path: Path):
    site = make_site(tmp_path, "docker compose run --rm worker deployer")
    (site / "ops/scripts/deploy.sh").unlink()
    result = run_validator(site)
    assert result.returncode == 1
    assert f"missing {site}/ops/scripts/deploy.sh" in result.stderr


def test_rejects_missing_crontab(tmp_path: Path):
    site = make_site(tmp_path, "docker compose run --rm worker deployer")
    (site / "ops/docker/crontab.docker").unlink()
    result = run_validator(site)
    assert result.returncode == 1
    assert f"missing {site}/ops/docker/crontab.docker" in result.stderr


@pytest.mark.parametrize("prefix", ["# ", "  # ", "\t# "])
def test_rejects_commented_out_deployer_schedule(tmp_path: Path, prefix: str):
    site = make_site(tmp_path, "docker compose run --rm worker deployer")
    (site / "ops/docker/crontab.docker").write_text(
        f"{prefix}*/5 * * * * bash ops/scripts/run-deployer.sh\n", encoding="utf-8"
    )
    result = run_validator(site)
    assert result.returncode == 1
    assert "no active run-deployer.sh schedule" in result.stderr


@pytest.mark.parametrize("prefix", ["# ", "  # ", "\t# "])
def test_rejects_commented_worker_dispatch(tmp_path: Path, prefix: str):
    result = run_validator(make_site(
        tmp_path, f"{prefix}docker compose run --rm worker deployer"
    ))
    assert result.returncode == 1
    assert "expected: docker compose run --rm worker deployer" in result.stderr


def test_rejects_echoed_worker_dispatch(tmp_path: Path):
    result = run_validator(make_site(
        tmp_path, 'echo "docker compose run --rm worker deployer"'
    ))
    assert result.returncode == 1
    assert "expected: docker compose run --rm worker deployer" in result.stderr


def test_accepts_multiline_entrypoint_dispatch(tmp_path: Path):
    site = make_site(tmp_path, "docker compose run --rm worker deployer")
    entrypoint = site / "ops/docker/entrypoint-worker.sh"
    entrypoint.write_text(
        entrypoint.read_text().replace("exec bash", "exec \\\n    bash"),
        encoding="utf-8",
    )
    result = run_validator(site)
    assert result.returncode == 0, result.stdout + result.stderr


def test_accepts_long_runner_without_pipefail_false_negative(tmp_path: Path):
    site = make_site(tmp_path, "docker compose run --rm worker deployer")
    with (site / "ops/scripts/run-deployer.sh").open("a", encoding="utf-8") as file:
        file.write(": harmless trailing command\n" * 10000)
    result = run_validator(site)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("prefix", ["# ", "  # ", "\t# "])
def test_rejects_commented_entrypoint_dispatch(tmp_path: Path, prefix: str):
    site = make_site(tmp_path, "docker compose run --rm worker deployer")
    (site / "ops/docker/entrypoint-worker.sh").write_text(
        f"{prefix}deployer) exec bash /work/ops/scripts/deploy.sh ;;\n",
        encoding="utf-8",
    )
    result = run_validator(site)
    assert result.returncode == 1
    assert "lacks an explicit deployer -> deploy.sh dispatch" in result.stderr


@pytest.mark.parametrize("script", [
    "ops/scripts/run-deployer.sh",
    "ops/scripts/deploy.sh",
    "ops/docker/entrypoint-worker.sh",
])
def test_rejects_invalid_shell_syntax(tmp_path: Path, script: str):
    site = make_site(tmp_path, "docker compose run --rm worker deployer")
    with (site / script).open("a", encoding="utf-8") as file:
        file.write("if true; then\n")
    result = run_validator(site)
    assert result.returncode == 1
    assert f"invalid shell syntax: {site / script}" in result.stderr


def test_rejects_dispatch_path_suffix(tmp_path: Path):
    site = make_site(tmp_path, "docker compose run --rm worker deployer")
    entrypoint = site / "ops/docker/entrypoint-worker.sh"
    entrypoint.write_text(
        entrypoint.read_text().replace("deploy.sh", "deploy.sh.disabled"),
        encoding="utf-8",
    )
    result = run_validator(site)
    assert result.returncode == 1
    assert "lacks an explicit deployer -> deploy.sh dispatch" in result.stderr


def test_rendered_canonical_templates_are_safe(tmp_path: Path):
    site = make_site(tmp_path, "docker compose run --rm worker deployer")
    placeholders = {
        "DOMAIN": "example.com",
        "BASE_URL": "https://example.com",
        "GIT_USER_NAME": "Example Desk",
        "GIT_USER_EMAIL": "bot@example.com",
        "SLACK_CHANNEL_VAR": "SLACK_CHANNEL_EXAMPLE",
        "SLACK_CHANNEL_DEFAULT": "domain-example-com",
        "SMOKE_TEST_CMD": 'bash ops/scripts/run-smoke-tests.sh "$BASE_URL"',
        "DEPLOY_ADD_PATHS": "site/src/ site/public/ ops/board/",
    }
    templates = ROOT / "tools/cron-roles/archetypes/deployer/scripts"
    for name in ("run-deployer.sh", "deploy.sh"):
        source = (templates / f"{name}.tmpl").read_text(encoding="utf-8")
        rendered = re.sub(
            r"\{\{([A-Z_]+)\}\}",
            lambda match: placeholders[match.group(1)],
            source,
        )
        assert not re.search(r"\{\{[A-Z_]+\}\}", rendered)
        (site / "ops/scripts" / name).write_text(rendered, encoding="utf-8")

    result = run_validator(site)
    assert result.returncode == 0, result.stdout + result.stderr
