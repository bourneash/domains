#!/usr/bin/env bash
# Delegator -> canonical fleet-wide tools/scripts/notify-slack.sh. Kept as a
# real file per site (not a symlink) so a site repo stays fully self-contained
# if cloned standalone; resolution mirrors the dual-path idiom already used
# fleet-wide for git-push-retry.sh / ai-usage-bootstrap.sh — .monorepo-tools
# is the read-only bind mount into worker/cron containers, the ../../tools
# fallback is for running directly on the host. See the canonical file's own
# header for usage, env overrides, and the 2026-09-13 centralization note.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CANONICAL="$REPO_ROOT/.monorepo-tools/scripts/notify-slack.sh"
[[ -x "$CANONICAL" ]] || CANONICAL="$REPO_ROOT/../../tools/scripts/notify-slack.sh"
NOTIFY_LOG_ROOT="$REPO_ROOT" exec "$CANONICAL" "$@"
