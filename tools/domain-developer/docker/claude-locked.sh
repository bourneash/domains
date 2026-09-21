#!/usr/bin/env bash
# Claude launcher for domain-developer workers.
#
# Each worker owns its own OAuth session. The lock covers the whole Claude
# process so two sessions in one worker cannot refresh the same token family
# concurrently. Workers are interactive sandboxes, so serializing sessions is
# safer than allowing an in-worker auth race.
set -u

REAL_CLAUDE="$(cat /etc/claude-real-path 2>/dev/null || true)"
LOCK_FILE="${CLAUDE_AUTH_LOCK:-/home/dev/.claude/.credentials.lock}"
LOCK_WAIT="${CLAUDE_AUTH_LOCK_WAIT:-600}"

[[ -x "${REAL_CLAUDE}" ]] || { echo "claude: real launcher is missing" >&2; exit 70; }

if [[ "${LOCK_FILE}" == "none" ]]; then
    exec "${REAL_CLAUDE}" "$@"
fi
if ! command -v flock >/dev/null 2>&1; then
    echo "claude: flock unavailable; refusing to start" >&2
    exit 75
fi
if [[ ! -e "${LOCK_FILE}" ]]; then
    (umask 077 && : > "${LOCK_FILE}") 2>/dev/null || {
        echo "claude: auth mutex cannot be created; refusing to start" >&2
        exit 75
    }
fi

exec {lockfd}>>"${LOCK_FILE}" 2>/dev/null || {
    echo "claude: shared auth mutex is not writable; refusing to start" >&2
    exit 75
}
if ! flock -w "${LOCK_WAIT}" -x "${lockfd}" 2>/dev/null; then
    exec {lockfd}>&-
    echo "claude: timed out waiting for shared auth mutex" >&2
    exit 75
fi

set +e
"${REAL_CLAUDE}" "$@"
status=$?
set -e
flock -u "${lockfd}" 2>/dev/null || true
exec {lockfd}>&-
exit "${status}"
