import os
import subprocess
from pathlib import Path


DOCTOR = Path(__file__).resolve().parents[1] / "bin" / "fleet-doctor"


def write_fixture(tmp_path: Path, marker: str) -> tuple[Path, dict[str, str]]:
    site = tmp_path / "sites" / "example.com"
    (site / "ops" / "docker").mkdir(parents=True)
    (site / "ops" / "docker" / "crontab.docker").write_text(
        f"{marker}# * * * * * bash ops/scripts/run-worker.sh engineer\n"
    )
    (site / "docker-compose.yml").write_text(
        """services:
  worker:
    image: fleet-site-worker:latest
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
  cron:
    image: fleet-site-cron:latest
    volumes:
      - ./ops/docker/crontab.docker:/etc/crontab.docker:ro
    environment:
      FLEET_WORKER_IMAGE: fleet-site-worker:latest
"""
    )

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    docker = fake_bin / "docker"
    docker.write_text(
        """#!/usr/bin/env bash
if [[ "$1" == image && "$2" == inspect ]]; then
  [[ "$4" == '{{.Id}}' ]] && echo sha256:current || echo 1.5.0
elif [[ "$1" == logs ]]; then
  echo 'time=now level=info msg="scheduling 0 jobs"'
elif [[ "$1" == exec && "$3" == id ]]; then
  echo 1000
elif [[ "$1" == exec && "$3" == grep ]]; then
  [[ "$5" == supercronic ]]
elif [[ "$1" == inspect ]]; then
  if [[ "$2" == --format ]]; then template="$3"; else template="$4"; fi
  case "$template" in
    '{{.State.Status}}') echo running ;;
    '{{.Image}}') echo sha256:current ;;
    '{{.HostConfig.CapDrop}}') echo '[ALL]' ;;
    '{{.HostConfig.SecurityOpt}}') echo '[no-new-privileges:true]' ;;
    '{{.HostConfig.PidsLimit}}') echo 512 ;;
    '{{.HostConfig.Privileged}}') echo false ;;
    '{{json .Config.Healthcheck.Test}}') echo '["CMD","grep","-qx","supercronic","/proc/1/comm"]' ;;
    '{{index .Config.Labels "autoheal"}}') echo true ;;
    *) exit 1 ;;
  esac
else
  exit 1
fi
"""
    )
    docker.chmod(0o755)
    env = os.environ.copy()
    env["FLEET_DOMAINS_ROOT"] = str(tmp_path)
    env["PATH"] = f"{fake_bin}:{env['PATH']}"
    return site, env


def run_doctor(tmp_path: Path, marker: str) -> subprocess.CompletedProcess[str]:
    _, env = write_fixture(tmp_path, marker)
    return subprocess.run(
        [str(DOCTOR), "example.com", "--quiet"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def test_explicitly_disabled_zero_job_schedule_passes(tmp_path):
    result = run_doctor(tmp_path, "# fleet-cron: disabled pre-launch\n")

    assert result.returncode == 0, result.stdout + result.stderr


def test_unmarked_zero_job_schedule_fails(tmp_path):
    result = run_doctor(tmp_path, "")

    assert result.returncode == 1
