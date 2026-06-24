#!/bin/sh
# amz-stats container entrypoint.
# 1. Source /work/.env.shared (bind-mounted from /home/jesse/projects/domains/.env)
#    so AMAZON_CREATORS_KEY_ID, AMAZON_CREATORS_KEY_SECRET, and
#    AMAZON_ASSOCIATES_STORE_ID are in the env that supercronic exports to each
#    cron tick.
# 2. Ensure /work/out exists.
# 3. Exec supercronic against the baked-in crontab.
set -e

echo "[$(date -Iseconds)] amz-stats container starting"

ENV_SHARED="/work/.env.shared"
if [ -f "$ENV_SHARED" ]; then
  set -a; . "$ENV_SHARED"; set +a
  echo "[$(date -Iseconds)] loaded .env.shared"
else
  echo "[$(date -Iseconds)] WARNING: $ENV_SHARED missing — Amazon API calls will fail"
fi

mkdir -p /work/out

# One verify on boot so a missing/expired token fails loudly instead of
# silently sitting through to the next 06:17 to discover it.
amz-stats verify || echo "[$(date -Iseconds)] WARNING: token verify failed"

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
