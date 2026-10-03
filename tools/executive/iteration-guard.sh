#!/usr/bin/env bash
# Scheduled work yields to the operator's controlled improvement session.
# Existing runs may finish; explicit session runs preserve ordinary gates.
if [[ -f "$ROOT/tools/executive/data/.iteration-paused" && "${TEAM_ITERATION_RUN:-0}" != "1" ]]; then
  echo "execution schedule paused for controlled team iteration"
  exit 0
fi
