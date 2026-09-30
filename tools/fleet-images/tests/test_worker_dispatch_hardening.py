"""Static regression tests for shared-worker recovery and dispatch guards."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
WRAPPER = ROOT / "sites/searchwoot.com/ops/scripts/run-worker.sh"
ENSURE = ROOT / "tools/fleet-images/bin/fleet-worker-ensure"


def test_cron_wrapper_uses_the_container_tools_mount_and_honors_kill_switch_first():
    text = WRAPPER.read_text(encoding="utf-8")

    assert 'SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"' in text
    assert '"$SCRIPT_DIR/.monorepo-tools/fleet-images/bin/fleet-worker-ensure"' in text
    assert text.index("ops/.${ROLE}-disabled") < text.index("_fwe_helper")


def test_shared_image_never_falls_back_to_a_registry_pull():
    text = WRAPPER.read_text(encoding="utf-8")

    shared_guard = text.index('if [[ "$IMG" == fleet-site-worker:* ]]')
    shared_block = text[shared_guard : text.index("fi\n  echo", shared_guard) + 2]
    assert "exit 78" in shared_block
    assert "docker compose build worker" not in shared_block
    assert "docker image inspect \"$IMG\"" in text


def test_worker_ensure_checks_the_promoted_fleet_version_label():
    text = ENSURE.read_text(encoding="utf-8")

    assert 'EXPECTED_VERSION="${FLEET_WORKER_VERSION:-}"' in text
    assert "org.domains.fleet.version" in text
    assert "does not match expected" in text
