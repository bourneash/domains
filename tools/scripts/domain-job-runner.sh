#!/usr/bin/env bash
# domain-job-runner.sh — host-side drainer for Fleet Dashboard domain jobs.
#
# WHY THIS EXISTS
# ---------------
# Onboarding/offboarding a domain is already fully implemented by
# tools/scripts/domain-manager-cli.sh (which itself only orchestrates
# bootstrap-domain.sh / full-bootstrap.sh / bind-worker-domain.sh /
# setup-cf-email.sh / remove-domain.sh). The Fleet Dashboard must NOT
# reimplement any of that — it only needs a way to *invoke* it.
#
# The dashboard can't run those scripts itself: its container is root, has no
# `gh`, no host node/nvm, and `git submodule add` from root would leave
# root-owned objects in the parent repo's .git (the known corruption mode —
# see the fleet notes on uid-1000 worker containers). So the panel *spools* a
# job as JSON and this script — running on the host, as jesse, from cron —
# picks it up and shells out to the real CLI.
#
# SPOOL LAYOUT   tools/fleet-dashboard/data/domain-jobs/   (gitignored)
#   <id>.json    job record: status queued -> running -> done|failed
#   <id>.log     combined stdout+stderr of the CLI invocation
#   .heartbeat   touched every tick so the UI can tell the runner is alive
#   .lock        flock target — one runner at a time
#
# Cron installs it at every minute; each invocation polls the spool for up to
# ~55s (2s between polls) so a job queued from the UI starts near-instantly
# instead of waiting out the cron minute. A job already in flight keeps the
# lock, so the next minute's cron simply exits.
#
# Usage:
#   tools/scripts/domain-job-runner.sh          # drain loop (cron entrypoint)
#   tools/scripts/domain-job-runner.sh --once   # drain queued jobs, then exit
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SPOOL="${DOMAIN_JOB_SPOOL:-${DOMAINS_ROOT}/tools/fleet-dashboard/data/domain-jobs}"
LOCK="${SPOOL}/.lock"
HEARTBEAT="${SPOOL}/.heartbeat"
LOOP_SECONDS="${DOMAIN_JOB_LOOP_SECONDS:-55}"
POLL_SECONDS="${DOMAIN_JOB_POLL_SECONDS:-2}"

# Host cron gave this almost no PATH and needed an explicit nvm/pyenv/snap
# hard-code for node+npm/python3/gh. Running inside tools/fleet-cron now,
# whose image provides that toolchain directly (node:22-alpine base + apk
# python3/git/gh) — no host-path assumptions needed. Override via
# DOMAIN_JOB_PATH if a future environment needs to inject something ahead of
# the image's own PATH.
export PATH="${DOMAIN_JOB_PATH:-$PATH}"
export HOME="${HOME:-/home/jesse}"
# Nothing here is a TTY; keep the CLI's output plain so the dashboard's log
# view doesn't have to strip ANSI escapes.
export NO_COLOR=1
export TERM=dumb
# Parallel astro/wrangler builds race on the default inspector port.
export NODE_OPTIONS="${NODE_OPTIONS:-} --inspect-port=0"

# Commands this runner is willing to dispatch, and the flags each accepts.
# Anything outside these lists is rejected here as well as in the dashboard —
# the spool is a file-backed queue, so the runner does not trust its contents.
supported_command() {
  case "$1" in
    add|remove|status|repair|deploy|bind|email|bootstrap) return 0 ;;
    *) return 1 ;;
  esac
}

supported_flag() {
  local cmd="$1" flag="$2"
  case "${cmd}:${flag}" in
    add:--full|add:--bootstrap-only|add:--no-deploy|add:--no-bind|add:--no-email) return 0 ;;
    # --delete-repo is deliberately absent: fleet policy is archive-never-delete,
    # so a spooled job can't reach it even if something hand-writes the record.
    remove:--no-github|remove:--no-cloudflare|remove:--no-local) return 0 ;;
    repair:--plan|repair:--no-email|repair:--no-deploy|repair:--no-bind) return 0 ;;
    bootstrap:--no-email) return 0 ;;
    *) return 1 ;;
  esac
}

valid_domain() {
  printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
}

# Rewrite a job record, preserving every field we don't touch. Written to a
# temp file and renamed into place: the dashboard container runs as root and
# may have created the original, which this (uid 1000) process cannot open for
# writing — but it can replace it, since the spool dir is jesse-owned.
patch_job() {
  local file="$1"
  shift
  local tmp
  tmp="$(mktemp "${SPOOL}/.patch.XXXXXX")"
  if python3 -c '
import json, sys

path = sys.argv[1]
with open(path) as fh:
    job = json.load(fh)

for pair in sys.argv[2:]:
    key, _, value = pair.partition("=")
    if value == "":
        job[key] = None
    elif value.lstrip("-").isdigit():
        job[key] = int(value)
    else:
        job[key] = value

json.dump(job, sys.stdout, indent=2)
' "${file}" "$@" > "${tmp}"; then
    mv -f "${tmp}" "${file}"
  else
    rm -f "${tmp}"
    return 1
  fi
}

read_field() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")' "$1" "$2"
}

read_flags() {
  python3 -c '
import json, sys
for flag in json.load(open(sys.argv[1])).get("flags") or []:
    print(flag)
' "$1"
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

fail_job() {
  local file="$1" message="$2"
  patch_job "${file}" "status=failed" "finishedAt=$(now)" "exitCode=1" "error=${message}" || true
}

run_job() {
  local file="$1"
  local id command domain
  id="$(read_field "${file}" id)"
  command="$(read_field "${file}" command)"
  domain="$(read_field "${file}" domain)"
  local log="${SPOOL}/${id}.log"

  if ! supported_command "${command}"; then
    fail_job "${file}" "unsupported command: ${command}"
    return 0
  fi
  if ! valid_domain "${domain}"; then
    fail_job "${file}" "invalid domain: ${domain}"
    return 0
  fi

  local flags=()
  local flag
  while IFS= read -r flag; do
    [ -z "${flag}" ] && continue
    if ! supported_flag "${command}" "${flag}"; then
      fail_job "${file}" "unsupported flag for ${command}: ${flag}"
      return 0
    fi
    flags+=("${flag}")
  done < <(read_flags "${file}")

  patch_job "${file}" "status=running" "startedAt=$(now)"

  local argv=("${command}" "${domain}" "${flags[@]}")

  {
    echo "=== domain-manager-cli.sh ${argv[*]} ==="
    echo "=== started $(now) (host runner, uid $(id -u)) ==="
    echo ""
  } > "${log}"

  local exit_code=0
  # </dev/null: every dispatched command is non-interactive, but a stray read
  # must fail fast rather than hang the queue forever.
  bash "${SCRIPT_DIR}/domain-manager-cli.sh" "${argv[@]}" \
    < /dev/null >> "${log}" 2>&1 || exit_code=$?

  {
    echo ""
    echo "=== exit ${exit_code} at $(now) ==="
  } >> "${log}"

  if [ "${exit_code}" -eq 0 ]; then
    patch_job "${file}" "status=done" "finishedAt=$(now)" "exitCode=0"
  else
    patch_job "${file}" "status=failed" "finishedAt=$(now)" "exitCode=${exit_code}" \
      "error=domain-manager-cli.sh exited ${exit_code}"
  fi
}

# Oldest queued job first, so the UI's queue order is honoured. Job ids are
# timestamp-prefixed (see server/domains.js), so lexical glob order IS time
# order — no mtime sort, which job-record rewrites would scramble.
next_queued() {
  local file
  for file in "${SPOOL}"/*.json; do
    [ -e "${file}" ] || continue
    if [ "$(read_field "${file}" status)" = "queued" ]; then
      printf '%s\n' "${file}"
      return 0
    fi
  done
  return 1
}

drain() {
  local file
  while file="$(next_queued)"; do
    run_job "${file}"
  done
}

main() {
  mkdir -p "${SPOOL}"

  exec 9>"${LOCK}"
  if ! flock -n 9; then
    # Another runner holds the spool — either mid-job or mid-poll. Nothing to do.
    exit 0
  fi

  if [ "${1:-}" = "--once" ]; then
    : > "${HEARTBEAT}"
    drain
    exit 0
  fi

  local deadline=$(( $(date +%s) + LOOP_SECONDS ))
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    : > "${HEARTBEAT}"
    drain
    sleep "${POLL_SECONDS}"
  done
  : > "${HEARTBEAT}"
}

main "$@"
