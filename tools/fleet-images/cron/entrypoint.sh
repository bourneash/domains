#!/usr/bin/env bash
# Shared cron-container entrypoint for every site in the fleet.
#
# Replaces 27 per-site ops/docker/entrypoint-cron.sh files. 21 of 27 were
# byte-identical once the site name was normalised out; this absorbs the real
# behaviour from the other six rather than dropping it:
#
#   broadwayshowgirls.com  sourced /secrets/.env instead of ./.env.shared
#                          -> ENV_FILE candidate list below
#   fishhooklabs.com       has no `worker` compose service yet (scaffold)
#                          -> worker check is skipped when the service is absent
#   amputeenews.com        pre-created ops/{logs,cache,.locks}
#                          -> done for every site now; harmless, and it stops a
#                             first-run role failing on a missing directory
#   newmomshop.com         compared a worker-runtime LABEL and rebuilt on
#                          mismatch, rather than only checking existence
#                          -> generalised into the version check below, because
#                             it is strictly better and it is the same idea
#                             fleet-doctor enforces
#   aliencouncil/ultrarough  wording-only differences
#
# Everything site-specific arrives as environment or as a bind mount. There are
# no site conditionals in here and there must never be: that is how 27 copies
# happened the first time.
set -uo pipefail

SITE_NAME="${SITE_NAME:-$(basename "$PWD")}"
STAMP() { printf '[%s] %s\n' "$(date -Iseconds)" "$*"; }

STAMP "fleet-site-cron starting — site=${SITE_NAME} image_version=${FLEET_IMAGE_VERSION:-unknown} uid=$(id -u) gid=$(id -g)"

# ── shared credentials ──────────────────────────────────────────────────────
# Cron-level scripts (notify-slack.sh and friends) need SLACK_BOT_TOKEN etc.
# without paying to spawn a whole worker container. First candidate that
# exists wins; CRON_ENV_FILE lets a site override without a code change.
for _candidate in "${CRON_ENV_FILE:-}" "${PWD}/.env.shared" "/secrets/.env"; do
    [[ -n "$_candidate" && -f "$_candidate" ]] || continue
    set -a
    # shellcheck disable=SC1090
    . "$_candidate"
    set +a
    STAMP "loaded env from ${_candidate}"
    break
done

# ── writable ops scaffolding ────────────────────────────────────────────────
# Roles assume these exist. Creating them here means a brand-new site's first
# scheduled run doesn't fail on a missing directory, and it costs nothing when
# they already exist.
mkdir -p ops/logs ops/cache ops/.locks 2>/dev/null || true

# ── worker image readiness ──────────────────────────────────────────────────
# Every scheduled role runs as `docker compose run --rm worker <role>`. If that
# image is missing the FIRST scheduled job of the day pays a multi-minute cold
# build while the clock runs; worse, two jobs firing close together can both
# start building. So resolve it once, here, before the scheduler starts.
#
# The check is on the image's version LABEL, not merely its existence
# (generalised from newmomshop.com's worker-runtime contract): an image that
# exists but predates the current shared build is exactly the stale-image drift
# the cattle model exists to prevent, and "it's present" would happily accept
# it.
WORKER_IMAGE="${FLEET_WORKER_IMAGE:-fleet-site-worker:latest}"
WORKER_EXPECT_VERSION="${FLEET_WORKER_VERSION:-}"

has_worker_service() {
    # COMPOSE_PROFILES='*' is REQUIRED here, not defensive padding.
    #
    # Every site declares the worker under `profiles: ["manual"]` (it is only
    # ever started via `docker compose run --rm worker <role>`, never brought
    # up). A bare `docker compose config --services` honours profiles and so
    # returns ONLY `cron` — meaning the plain check reported "no worker
    # service" on all 27 sites and the pre-build below would have silently
    # never run, on any of them, forever. Caught on the first canary
    # (offshorehookup.com) because fleet-doctor read the YAML directly and
    # disagreed with the entrypoint.
    #
    # `--profile manual` also works but hardcodes a profile name a site could
    # rename; '*' does not.
    COMPOSE_PROFILES='*' docker compose config --services 2>/dev/null | grep -qx worker
}

worker_label_version() {
    docker image inspect --format \
        '{{ index .Config.Labels "org.domains.fleet.version" }}' \
        "$WORKER_IMAGE" 2>/dev/null || true
}

if ! has_worker_service; then
    # fishhooklabs.com and other scaffolds legitimately have no worker yet.
    STAMP "no 'worker' service in this site's compose — skipping worker image check"
else
    have="$(worker_label_version)"
    if ! docker image inspect "$WORKER_IMAGE" >/dev/null 2>&1; then
        STAMP "worker image ${WORKER_IMAGE} missing — building before starting scheduler"
        need_build=1
    elif [[ -n "$WORKER_EXPECT_VERSION" && "$have" != "$WORKER_EXPECT_VERSION" ]]; then
        STAMP "worker image ${WORKER_IMAGE} is version '${have:-none}', expected '${WORKER_EXPECT_VERSION}' — rebuilding"
        need_build=1
    else
        STAMP "worker image ${WORKER_IMAGE} ready (version ${have:-unlabelled})"
        need_build=0
    fi

    if [[ "${need_build:-0}" == "1" ]]; then
        # `docker compose build` writes to ~/.docker; fall back to a tmp config
        # dir when HOME isn't writable in this container.
        if ! mkdir -p "${HOME:-/home/ops}/.docker" 2>/dev/null; then
            export DOCKER_CONFIG=/tmp/.docker-config
            mkdir -p "$DOCKER_CONFIG"
        fi
        if docker compose build worker; then
            STAMP "worker image ready (version $(worker_label_version || echo unlabelled))"
        else
            # Do NOT abort. A scheduler that refuses to start because one build
            # failed takes out every job on the site, including the watchdog
            # that would have reported the problem. Start, and let the first
            # role invocation surface the build error through its own channel.
            STAMP "WARNING: worker image build FAILED — starting the scheduler anyway so watchdog/monitor jobs still run; the next role invocation will report the build error"
        fi
    fi
fi

# ── scheduler ───────────────────────────────────────────────────────────────
# /etc/crontab.docker is BIND-MOUNTED from the site repo, never baked. Editing
# ops/docker/crontab.docker and restarting the container is the whole
# reschedule procedure — no image rebuild in the loop.
CRONTAB_FILE="${CRONTAB_FILE:-/etc/crontab.docker}"
if [[ ! -r "$CRONTAB_FILE" ]]; then
    STAMP "FATAL: ${CRONTAB_FILE} is not readable. It is bind-mounted from ops/docker/crontab.docker — check the site's compose volumes."
    exit 1
fi
STAMP "scheduling $(grep -cvE '^\s*(#|$)' "$CRONTAB_FILE") job(s) from ${CRONTAB_FILE}"

exec /usr/local/bin/supercronic -passthrough-logs "$CRONTAB_FILE"
