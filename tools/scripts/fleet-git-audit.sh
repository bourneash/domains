#!/usr/bin/env bash
# Fleet-wide git audit: scans the parent repo + every sites/* submodule for
# uncommitted changes, unpushed commits, stale/ahead branches, worktrees, and stashes.
#
# Usage: tools/scripts/fleet-git-audit.sh [--json]
#   --json    emit machine-readable JSON instead of the human report
#
# Exit code: 0 = clean fleet, 1 = at least one repo has outstanding work (dirty tree,
# unpushed commits, non-main branches with unique commits, or stashes).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
JSON_MODE=0
[[ "${1:-}" == "--json" ]] && JSON_MODE=1

FINDINGS=0
JSON_ITEMS=()

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

audit_repo() {
  local name="$1" path="$2"
  local issues=()

  pushd "$path" >/dev/null || return

  # 1. Dirty working tree
  local dirty
  dirty="$(git status --porcelain 2>/dev/null)"
  if [[ -n "$dirty" ]]; then
    local n
    n=$(printf '%s\n' "$dirty" | wc -l)
    issues+=("dirty: $n file(s) uncommitted")
  fi

  # 2. Current branch unpushed / no upstream
  local branch
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [[ -n "$branch" && "$branch" != "HEAD" ]]; then
    local upstream
    upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"
    if [[ -z "$upstream" ]]; then
      issues+=("branch '$branch' has no upstream (never pushed)")
    else
      local ahead
      ahead="$(git rev-list --count "@{u}..HEAD" 2>/dev/null || echo 0)"
      if [[ "$ahead" -gt 0 ]]; then
        issues+=("branch '$branch' is $ahead commit(s) ahead of upstream (unpushed)")
      fi
    fi
  fi

  # 3. Other local branches with unique commits vs main/master
  local default_branch
  default_branch="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')"
  [[ -z "$default_branch" ]] && default_branch="main"
  git for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null | while read -r b; do
    [[ "$b" == "$default_branch" ]] && continue
    local ahead
    ahead="$(git rev-list --count "${default_branch}..${b}" 2>/dev/null || echo 0)"
    if [[ "$ahead" -gt 0 ]]; then
      echo "branch '$b' has $ahead commit(s) not in $default_branch"
    fi
  done > /tmp/.fleet_audit_branches.$$
  while IFS= read -r line; do
    [[ -n "$line" ]] && issues+=("$line")
  done < /tmp/.fleet_audit_branches.$$
  rm -f /tmp/.fleet_audit_branches.$$

  # 4. Worktrees other than the primary
  local wt_count
  wt_count="$(git worktree list 2>/dev/null | wc -l)"
  if [[ "$wt_count" -gt 1 ]]; then
    issues+=("$((wt_count - 1)) extra worktree(s) present")
  fi

  # 5. Stashes
  local stash_count
  stash_count="$(git stash list 2>/dev/null | wc -l)"
  if [[ "$stash_count" -gt 0 ]]; then
    issues+=("$stash_count stash(es)")
  fi

  popd >/dev/null || return

  if [[ ${#issues[@]} -gt 0 ]]; then
    FINDINGS=1
    if [[ "$JSON_MODE" -eq 1 ]]; then
      local items_json=""
      for i in "${issues[@]}"; do
        items_json+="\"$(json_escape "$i")\","
      done
      items_json="${items_json%,}"
      JSON_ITEMS+=("{\"repo\":\"$(json_escape "$name")\",\"path\":\"$(json_escape "$path")\",\"issues\":[$items_json]}")
    else
      echo "## $name"
      for i in "${issues[@]}"; do
        echo "  - $i"
      done
      echo
    fi
  fi
}

# Parent repo itself
audit_repo "domains (parent)" "$ROOT"

# Every submodule under sites/
while IFS= read -r sm_path; do
  [[ -z "$sm_path" ]] && continue
  full="$ROOT/$sm_path"
  [[ -d "$full/.git" || -f "$full/.git" ]] || continue
  name="$(basename "$sm_path")"
  audit_repo "$name" "$full"
done < <(git config -f "$ROOT/.gitmodules" --get-regexp '\.path$' 2>/dev/null | awk '{print $2}' | grep '^sites/')

if [[ "$JSON_MODE" -eq 1 ]]; then
  printf '['
  IFS=,; printf '%s' "${JSON_ITEMS[*]:-}"; unset IFS
  printf ']\n'
else
  if [[ "$FINDINGS" -eq 0 ]]; then
    echo "Fleet is clean — no uncommitted, unpushed, or stale git work found."
  fi
fi

exit "$FINDINGS"
