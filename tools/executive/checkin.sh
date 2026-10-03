#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# All parent-repository mutations must share this lock. The old /tmp
# check-in-only lock did not coordinate with other cron writers, allowing a
# concurrent commit to move HEAD between Git's compare-and-update steps.
GIT_MUTATION_LOCK_FILE="${FLEET_GIT_MUTATION_LOCK_FILE:-$ROOT/tools/.git-mutation.lock}"
GIT_MUTATION_LOCK_WAIT_SECONDS="${FLEET_GIT_MUTATION_LOCK_WAIT_SECONDS:-90}"

cd "$ROOT"

# fleet-cron has the shared SSH key mounted but not the operator's SSH alias
# configuration. Resolve the repository's github-bourneash remotes explicitly
# so a handoff can push without exposing or broadening credentials.
# Handoff runs may inherit a stale SSH command from the scheduler/container.
# When the repository's scoped deploy identity is mounted, it is the only
# identity this automation is allowed to use for the configured GitHub alias.
if [[ -f "${HOME:-/home/jesse}/.ssh/github-bourneash" ]]; then
  export GIT_SSH_COMMAND="ssh -F /dev/null -i ${HOME:-/home/jesse}/.ssh/github-bourneash -o UserKnownHostsFile=${HOME:-/home/jesse}/.ssh/known_hosts -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -o HostName=github.com"
fi

check_in_once() {
  if [[ -z "$(git status --porcelain -- ops/executive/handoffs)" ]]; then
    return 0
  fi

  git add -- ops/executive/handoffs
  # The fleet-cron container intentionally does not inherit an operator's
  # global git identity. Supply a stable service identity so a successful
  # manager run is not reported as failed merely because the handoff commit
  # has no author.
  git -c user.name="Fleet Executive" \
    -c user.email="fleet-executive@domains.local" \
    commit --only -m "chore: check in executive handoffs" -- ops/executive/handoffs
  CHECKIN_COMMIT="$(git rev-parse HEAD)"
  CHECKIN_BRANCH="$(git symbolic-ref --short HEAD)"
}

# Cooperating writers are serialized by the shared lock above. Retry a small
# class of transient ref/index races anyway: older containers and operator
# processes may not yet know about this lock. Never retry merge conflicts or
# other substantive Git failures.
CHECK_LOG="$(mktemp "${TMPDIR:-/tmp}/executive-checkin.XXXXXX")"
trap 'rm -f "$CHECK_LOG"' EXIT
CHECKIN_COMMIT=""
CHECKIN_BRANCH=""
for attempt in 1 2 3; do
  exec 9>"$GIT_MUTATION_LOCK_FILE"
  if ! flock -w "$GIT_MUTATION_LOCK_WAIT_SECONDS" 9; then
    exec 9>&-
    echo "executive handoff check-in deferred: top-level Git mutation lock is busy" >&2
    exit 75
  fi
  set +e
  check_in_once >"$CHECK_LOG" 2>&1
  check_status=$?
  set -e
  # Logging and network pushes can stall independently of Git. Neither may
  # retain the shared mutation lock after the local commit has finished.
  flock -u 9
  exec 9>&-
  if (( check_status == 0 )); then
    push_status=0
    if [[ -n "$CHECKIN_COMMIT" && "${EXECUTIVE_HANDOFF_PUSH:-1}" == "1" ]]; then
      timeout "${EXECUTIVE_HANDOFF_PUSH_TIMEOUT_SECONDS:-60}" \
        git push origin "$CHECKIN_COMMIT:refs/heads/$CHECKIN_BRANCH" >>"$CHECK_LOG" 2>&1 || push_status=$?
    fi
    tail -n 20 "$CHECK_LOG"
    exit "$push_status"
  fi
  tail -n 20 "$CHECK_LOG"
  if (( attempt < 3 )) && grep -Eiq \
    'cannot lock ref|unable to create .*\.lock|could not lock|index\.lock' "$CHECK_LOG"; then
    echo "executive handoff check-in hit a transient Git lock race; retrying (${attempt}/3)" >&2
    sleep 2
    continue
  fi
  exit "$check_status"
done
