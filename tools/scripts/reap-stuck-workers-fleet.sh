#!/usr/bin/env bash
# Fleet-wide reaper: force-kills stray one-shot worker containers that outlive
# any legitimate role run, across EVERY site in one pass.
#
# Replaces 16 identical per-site `reap-stuck-workers.sh` copies that each ran
# on their own site's cron container every 15 min (7,22,37,52 * * * *) — same
# check, same threshold, just 16x the process/API-call overhead for zero extra
# coverage (docker.sock is the same shared host daemon for every site anyway).
# See tools/scripts/ensure-fleet-cron.sh for the same host-cron, fleet-loop
# pattern this mirrors.
#
# `docker compose run --rm worker <role>` is supposed to be ephemeral, but
# supercronic's `timeout` only kills the CLIENT process under a headless
# (no-TTY) invocation — it does NOT propagate to the CONTAINER, so a hung role
# (or a manual `docker compose run` debug session someone forgot to close) can
# sit running for days, holding host resources and its ops/.locks/<role>.lock
# flock forever, wedging every later scheduled run.
#
# Pure bash, no Claude — runs host-direct so detection and cleanup cost zero
# tokens. Kill threshold: nothing any project runs legitimately takes anywhere
# close to an hour (roles are turn-capped LLM calls or curl/build sweeps).
# Default 3600s leaves generous headroom; override with REAPER_MAX_AGE_SEC.
#
# EXCEPTION: affiliate-audit (tools/affiliate-audit/run.py) is a real
# exception to that assumption, not a bug to route around elsewhere — its
# CloakBrowser sweep paces 12-25s between every product (127 on totaljerks
# alone => ~35-50min for the sweep by itself) plus up to several sequential
# turn-capped `claude -p` resolution-agent invocations for flagged products,
# each with its own 30min subprocess timeout. Confirmed via
# reap-stuck-workers-fleet.log: this reaper killed totaljerks' worker
# mid-run TWICE on 2026-07-29 (ages 74m and 71m) before this override
# existed, wiping out state-file persistence, the run's own status
# bookkeeping, and any commit/push for whatever it had already resolved.
# Detected per-role (not per-site) via the container's own invoked args
# (`docker compose run --rm worker <role>`) since role name isn't part of
# the container name. Add further entries here if another role gains a
# similarly long legitimate runtime — don't just raise the global default,
# that weakens this reaper's whole purpose for every fast role.
set -uo pipefail

SITES_DIR="/home/jesse/projects/domains/sites"
LOG="/home/jesse/projects/domains/tools/scripts/reap-stuck-workers-fleet.log"
MAX_AGE_SEC="${REAPER_MAX_AGE_SEC:-3600}"
declare -A ROLE_MAX_AGE_SEC=(
  [affiliate-audit]="${REAPER_MAX_AGE_SEC_AFFILIATE_AUDIT:-10800}"  # 3h
)

# Running host-direct (not inside a per-site container), so the shared .env
# is a plain read — no .env.shared bind-mount indirection needed. NOTE: the
# per-site reapers this replaces never sourced this (or SLACK_BOT_TOKEN), so
# their Slack notify was a silent no-op in practice; sourcing it here for
# real is an intentional side-effect of moving host-side, not scope creep —
# flagged in the PR/commit message.
[[ -f /home/jesse/projects/domains/.env ]] && { set -a; . /home/jesse/projects/domains/.env; set +a; }

# Per-site Slack channel env-var name, exactly as each removed
# reap-stuck-workers.sh resolved it (`${SLACK_CHANNEL_<KEY>:-domain-<site>}`).
# Hardcoded rather than re-derived at runtime — the source of truth (the
# per-site scripts) is going away with this consolidation.
declare -A CHANNEL_KEY=(
  [3boobs.com]=3BOOBS
  [0daynews.com]=0DAYNEWS
  [0xroulette.com]=0XROULETTE
  [aliencouncil.com]=ALIENCOUNCIL
  [americastrikes.com]=AMERICA_STRIKES
  [broadwayshowgirls.com]=BROADWAY_SHOW_GIRLS
  [deeppenetrations.com]=DEEPPENETRATIONS
  [rc-9.com]=RC9
  [reviewtattoo.com]=REVIEWTATTOO
  [saveusfarms.com]=SAVE_US_FARMS
  [shoptopless.com]=SHOPTOPLESS
  [sinderella.org]=SINDERELLA
  [totaljerks.com]=TOTALJERKS
  [ultrarough.com]=ULTRAROUGH
  [weapontester.com]=WEAPONTESTER
  [wetpages.com]=WETPAGES
  [xxxtea.com]=XXXTEA
)

# Renders a duration in seconds as e.g. "45s" or "12m" -- test runs (a low
# REAPER_MAX_AGE_SEC used to validate the reaper) finish in seconds, and
# truncating those to whole minutes made every test alert read as a
# confusing "running 0m (threshold 0m)".
fmt_dur() {
  local s=$1
  if (( s < 60 )); then
    echo "${s}s"
  else
    echo "$(( s / 60 ))m"
  fi
}

# One `docker ps` call for every one-shot container fleet-wide, instead of 16
# separate `docker ps --filter working_dir=<site>` calls — the working_dir
# label on each container still tells us which site (and therefore which
# notify script + channel) it belongs to.
mapfile -t IDS < <(docker ps -q --filter "label=com.docker.compose.oneoff=True")

for id in "${IDS[@]}"; do
  [[ -z "$id" ]] && continue

  working_dir="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$id" 2>/dev/null)"
  # Only reap containers belonging to a known site under $SITES_DIR — leave
  # anything else (dev tooling, CI runners, secscan executors) alone.
  case "$working_dir" in
    "$SITES_DIR"/*) ;;
    *) continue ;;
  esac
  site_dir="$working_dir"

  started="$(docker inspect -f '{{.State.StartedAt}}' "$id" 2>/dev/null)" || continue
  # Docker emits RFC3339Nano (fractional seconds); busybox `date` can't parse
  # that at all, even with -D. Strip the fraction first, then try GNU `date -d`
  # and fall back to busybox's explicit-format `-D` for the same string.
  started_stripped="${started%%.*}Z"
  started_epoch="$(date -u -d "$started_stripped" +%s 2>/dev/null \
    || date -u -D '%Y-%m-%dT%H:%M:%SZ' -d "$started_stripped" +%s 2>/dev/null)"
  [[ -z "$started_epoch" ]] && continue
  now_epoch="$(date +%s)"
  age_sec=$(( now_epoch - started_epoch ))

  # `docker compose run --rm worker <role>` names containers
  # <project>-worker-run-<hash> — the role isn't in the name, only in the
  # container's own invoked args (index 0, right after the image's
  # ENTRYPOINT). Missing/unreadable -> empty role -> falls through to the
  # global default threshold below, same as before this override existed.
  role="$(docker inspect -f '{{index .Args 0}}' "$id" 2>/dev/null || true)"
  threshold="${ROLE_MAX_AGE_SEC[$role]:-$MAX_AGE_SEC}"

  if (( age_sec > threshold )); then
    name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's#^/##')"
    age_human="$(fmt_dur "$age_sec")"
    threshold_human="$(fmt_dur "$threshold")"
    echo "$(date -Iseconds) [$(basename "$site_dir")] reap-stuck-workers: killing $name (id=$id, age=${age_human}, threshold=${threshold_human})" >> "$LOG"

    docker kill "$id" >/dev/null 2>&1 || true
    docker rm -f "$id" >/dev/null 2>&1 || true

    notify="$site_dir/ops/scripts/notify-slack.sh"
    site_slug="$(basename "$site_dir")"
    default_channel="domain-$(echo "$site_slug" | tr '.' '-')"
    key="${CHANNEL_KEY[$site_slug]:-}"
    if [[ -n "$key" ]]; then
      var="SLACK_CHANNEL_${key}"
      channel="${!var:-$default_channel}"
    else
      channel="$default_channel"
    fi

    if [[ -x "$notify" ]]; then
      "$notify" "$channel" \
        ":wastebasket: Reaper killed stuck worker container \`$name\` — running ${age_human} (threshold ${threshold_human}). If this threshold looks unusually low, it was likely a deliberate reaper test (e.g. a REAPER_MAX_AGE_SEC override) -- no action needed. Otherwise, if this was legitimate work, bump REAPER_MAX_AGE_SEC in this fleet reaper's crontab entry." \
        "warning" 2>/dev/null || true
    fi
  fi
done

exit 0
