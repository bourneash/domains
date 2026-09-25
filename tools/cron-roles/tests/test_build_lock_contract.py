"""Fleet contract: every shared dist build must acquire the site build lock."""

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[3]
SITES = ROOT / "sites"
ARCHETYPES = ROOT / "tools/cron-roles/archetypes"


def check_role(path: Path) -> list[str]:
    text = path.read_text(errors="replace")
    if "deploy-build.lock" not in text:
        return []
    errors = []
    guard = "if ! flock -w 900 8; then"
    if "flock -w 900 8 || log" in text:
        errors.append("build-lock timeout continues into a build")
    if text.count(guard) != 1:
        errors.append("expected one fail-closed build-lock guard")
        return errors
    lock_at = text.index(guard)
    model_at = text.find('timeout "$WORK_TIMEOUT"')
    if model_at >= 0 and lock_at > model_at:
        errors.append("model runs before build lock is acquired")
    # Earlier mentions are often comments explaining the historical race.
    gate_at = text.rfind("rm -rf dist")
    if gate_at >= 0 and lock_at > gate_at:
        errors.append("dist is removed before build lock is acquired")
    branch = re.search(r"if ! flock -w 900 8; then(.*?)\n\s*fi", text[lock_at:], re.S)
    if not branch or "exit 0" not in branch.group(1):
        errors.append("busy build lock does not defer the pass")
    return errors


def check_deployer(path: Path) -> list[str]:
    text = path.read_text(errors="replace")
    if "rm -rf dist" not in text:
        return []
    guard = "if ! flock -n 8; then"
    if "deploy-build.lock" not in text or guard not in text:
        return ["deployer builds without a nonblocking build lock"]
    if text.index(guard) > text.rfind("rm -rf dist"):
        return ["deployer removes dist before build lock is acquired"]
    return []


def main() -> int:
    failures = []
    paths = list(SITES.glob("*/ops/scripts/watchdog.sh"))
    paths += list(SITES.glob("*/ops/scripts/run-engineer.sh"))
    paths += [ARCHETYPES / "watchdog/scripts/watchdog.sh.tmpl",
              ARCHETYPES / "engineer/scripts/run-engineer.sh.tmpl"]
    for path in paths:
        failures += [f"{path.relative_to(ROOT)}: {error}" for error in check_role(path)]
    deployers = list(SITES.glob("*/ops/scripts/deploy.sh"))
    deployers.append(ARCHETYPES / "deployer/scripts/deploy.sh.tmpl")
    for path in deployers:
        failures += [f"{path.relative_to(ROOT)}: {error}" for error in check_deployer(path)]
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("build-lock contract passed across fleet and archetypes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
