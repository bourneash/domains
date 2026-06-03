#!/bin/sh
# gh-stats container entrypoint. Mirrors cf-stats/entrypoint.sh.
# 1. Source /work/.env.shared for GITHUB_TOKEN.
# 2. Ensure /work/out exists.
# 3. Exec supercronic (absolute path required — see cf-stats entrypoint note).
set -e

echo "[$(date -Iseconds)] gh-stats container starting"

ENV_SHARED="/work/.env.shared"
if [ -f "$ENV_SHARED" ]; then
  set -a; . "$ENV_SHARED"; set +a
  echo "[$(date -Iseconds)] loaded .env.shared"
else
  echo "[$(date -Iseconds)] WARNING: $ENV_SHARED missing — GitHub API calls will fail"
fi

mkdir -p /work/out

gh-stats verify || echo "[$(date -Iseconds)] WARNING: token verify failed"

# Absolute path is REQUIRED here. As PID 1 with reaping enabled,
# supercronic's reaper.go forkExec's a *new* supercronic child (which then
# runs the scheduler with -no-reap), while PID 1 stays behind to reap
# zombies. The re-fork uses syscall.ForkExec(os.Args[0], ...), and
# os.Args[0] is resolved against the working dir (/work), NOT against
# PATH. If we invoke as `exec supercronic`, os.Args[0]=="supercronic"
# → re-fork tries /work/supercronic → ENOENT → "Failed to fork exec".
# Invoking by absolute path makes os.Args[0]=="/usr/local/bin/supercronic"
# and the reaper-spawned child finds the binary.
# Ref: supercronic v0.2.34 reaper.go forkExec().
exec /usr/local/bin/supercronic -passthrough-logs /etc/crontab.docker
