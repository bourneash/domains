#!/usr/bin/env bash
# Shared per-site repository mutation lock.
#
# Source this file, then call:
#   repo_mutation_lock_acquire "$REPO_ROOT" "$ROLE" [wait_seconds]
#   repo_mutation_lock_release
#
# The lock is a mkdir rather than flock so shell roles, Docker bind mounts,
# and fleet-git's Node process all use the same cross-container primitive.

REPO_MUTATION_LOCK_STALE_SECS="${REPO_MUTATION_LOCK_STALE_SECS:-10800}"
REPO_MUTATION_LOCK_HELD=0
REPO_MUTATION_LOCK_DIR=""
REPO_MUTATION_LOCK_TOKEN=""

repo_mutation_lock_acquire() {
  local repo_root="$1" owner="${2:-unknown}" wait_secs="${3:-0}"
  local started now age stale_dir
  REPO_MUTATION_LOCK_DIR="$repo_root/ops/.locks/repo-mutation.lock.d"
  REPO_MUTATION_LOCK_TOKEN="${owner}:$$:$(date +%s)"
  mkdir -p "$repo_root/ops/.locks"
  started="$(date +%s)"

  while true; do
    if mkdir "$REPO_MUTATION_LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$REPO_MUTATION_LOCK_TOKEN" > "$REPO_MUTATION_LOCK_DIR/owner"
      REPO_MUTATION_LOCK_HELD=1
      return 0
    fi

    now="$(date +%s)"
    age=$(( now - $(stat -c %Y "$REPO_MUTATION_LOCK_DIR" 2>/dev/null || echo "$now") ))
    if (( age > REPO_MUTATION_LOCK_STALE_SECS )); then
      stale_dir="${REPO_MUTATION_LOCK_DIR}.stale.$$"
      if mv "$REPO_MUTATION_LOCK_DIR" "$stale_dir" 2>/dev/null; then
        rm -f "$stale_dir/owner"
        rmdir "$stale_dir" 2>/dev/null || true
        continue
      fi
    fi

    (( now - started >= wait_secs )) && return 1
    sleep 2
  done
}

repo_mutation_lock_release() {
  [[ "$REPO_MUTATION_LOCK_HELD" == "1" ]] || return 0
  if [[ "$(cat "$REPO_MUTATION_LOCK_DIR/owner" 2>/dev/null || true)" == "$REPO_MUTATION_LOCK_TOKEN" ]]; then
    rm -f "$REPO_MUTATION_LOCK_DIR/owner"
    rmdir "$REPO_MUTATION_LOCK_DIR" 2>/dev/null || true
  fi
  REPO_MUTATION_LOCK_HELD=0
}
