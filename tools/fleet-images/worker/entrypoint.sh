#!/usr/bin/env bash
# Shared worker-container entrypoint — a DISPATCHER, deliberately thin.
#
# The role logic itself stays in each site's repo (ops/docker/entrypoint-worker.sh
# or ops/scripts/run-worker.sh, both bind-mounted at /work). This file exists
# only because the fleet had three different conventions for where that script
# lives, and hardcoding one of them into a shared image would have forced two
# sites to keep bespoke images forever:
#
#   /work/ops/docker/entrypoint-worker.sh   24 sites
#   ops/docker/entrypoint-worker.sh (rel.)  amputeenews.com
#   /repo/ops/scripts/run-worker.sh         broadwayshowgirls.com (mounts /repo)
#
# Resolution order below covers all three plus an explicit override. Keep this
# file boring: anything that varies per site belongs on the other side of the
# dispatch, in the site's own repo.
set -uo pipefail

STAMP() { printf '[%s] %s\n' "$(date -Iseconds)" "$*" >&2; }

# Some sites bind their repo somewhere other than /work (broadwayshowgirls uses
# /repo). Honour the compose working_dir we were started in rather than
# assuming.
ROOT="${FLEET_WORKER_ROOT:-$PWD}"

candidates=(
    "${WORKER_ENTRYPOINT:-}"
    "${ROOT}/ops/docker/entrypoint-worker.sh"
    "${ROOT}/ops/scripts/run-worker.sh"
    "/work/ops/docker/entrypoint-worker.sh"
    "/work/ops/scripts/run-worker.sh"
    "/repo/ops/docker/entrypoint-worker.sh"
    "/repo/ops/scripts/run-worker.sh"
)

for target in "${candidates[@]}"; do
    [[ -n "$target" && -f "$target" ]] || continue
    STAMP "fleet-site-worker ${FLEET_IMAGE_VERSION:-unknown} · uid=$(id -u) · dispatching to ${target}"
    if [[ -x "$target" ]]; then
        exec "$target" "$@"
    fi
    # Repo checkouts don't always carry the exec bit (and /work may be mounted
    # from a host filesystem that drops it). Falling back to an explicit
    # interpreter is better than failing on a permission bit.
    exec bash "$target" "$@"
done

STAMP "FATAL: no worker entrypoint found under ${ROOT}."
STAMP "Looked for: ops/docker/entrypoint-worker.sh, ops/scripts/run-worker.sh (also under /work and /repo)."
STAMP "Set WORKER_ENTRYPOINT in this site's compose if the script lives elsewhere."
exit 127
