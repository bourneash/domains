#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec 9>"/tmp/domains-executive-handoff-checkin.lock"
flock -n 9 || exit 0

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

if [[ -z "$(git status --porcelain -- ops/executive/handoffs)" ]]; then
  exit 0
fi

git add -- ops/executive/handoffs
# The fleet-cron container intentionally does not inherit an operator's global
# git identity. Supply a stable service identity so a successful manager run is
# not reported as failed merely because the handoff commit has no author.
git -c user.name="Fleet Executive" \
  -c user.email="fleet-executive@domains.local" \
  commit -m "chore: check in executive handoffs"
if [[ "${EXECUTIVE_HANDOFF_PUSH:-1}" == "1" ]]; then
  git push origin HEAD
fi
