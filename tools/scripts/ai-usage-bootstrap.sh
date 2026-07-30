#!/usr/bin/env bash
# Shared initialization for any ops script that can invoke Claude.
#
# Source this after REPO_ROOT is known, then invoke "$CLAUDE_TRACKED" in place
# of `claude`.  It deliberately does not infer data from logs: every completed
# (or failed) Claude process writes an authoritative JSON ledger record.

if [[ -z "${REPO_ROOT:-}" ]]; then
  echo "ai-usage-bootstrap.sh: REPO_ROOT must be set before sourcing" >&2
  return 64 2>/dev/null || exit 64
fi

if [[ -z "${CRON_SITE:-}" ]]; then
  export CRON_SITE="$(basename "$REPO_ROOT")"
fi

if [[ -z "${CRON_ROLE:-}" ]]; then
  _ai_usage_script="${BASH_SOURCE[1]:-$0}"
  _ai_usage_role="$(basename "${_ai_usage_script%.sh}")"
  _ai_usage_role="${_ai_usage_role#run-}"
  export CRON_ROLE="${_ai_usage_role:-unknown}"
  unset _ai_usage_script _ai_usage_role
fi

CLAUDE_TRACKED="${CLAUDE_TRACKED:-$REPO_ROOT/.monorepo-tools/scripts/claude-tracked.sh}"
[[ -x "$CLAUDE_TRACKED" ]] || CLAUDE_TRACKED="$REPO_ROOT/../../tools/scripts/claude-tracked.sh"
if [[ ! -x "$CLAUDE_TRACKED" ]]; then
  echo "ai-usage-bootstrap.sh: tracked Claude wrapper not executable: $CLAUDE_TRACKED" >&2
  return 127 2>/dev/null || exit 127
fi
export CLAUDE_TRACKED
