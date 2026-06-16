#!/usr/bin/env bash
# enqueue-engineer-task.sh — let any role hand work to the Engineer.
#
# Drops a correctly-formatted `assigned_role: engineer` task into the backlog.
# The Engineer's 4-hourly cron run picks these up (up to 3/run, by priority).
#
# Usage:
#   enqueue-engineer-task.sh "<title>" <priority 1-5> "<body markdown>" [type]
#
# (Generic across all domains — no per-project values; ship as-is.)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TITLE="${1:?usage: enqueue-engineer-task.sh \"<title>\" <priority> \"<body>\" [type]}"
PRIORITY="${2:-3}"
BODY="${3:-}"
TYPE="${4:-engineering}"

BACKLOG="$REPO_ROOT/ops/tasks/backlog"
mkdir -p "$BACKLOG"

TODAY="$(date -u +%Y-%m-%d)"
SLUG=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-48)
SUFFIX="$(date -u +%H%M%S)"
FILE="$BACKLOG/${TODAY}-eng-${SLUG}-${SUFFIX}.md"

cat > "$FILE" <<EOF
---
title: "${TITLE//\"/\'}"
priority: ${PRIORITY}
type: ${TYPE}
estimated_turns: 10
created: ${TODAY}
assigned_role: engineer
---

${BODY}

_Enqueued for the Engineer by ${ENGINEER_ENQUEUED_BY:-$(basename "${0%.*}")} on ${TODAY}._
EOF

echo "$FILE"
