#!/usr/bin/env bash
# Fleet post-deploy verification: assert the edge is serving what was just built.
#
# WHY THIS EXISTS
# On 2026-09-01 an eastcoastrappers.com deploy shipped a worker that served /
# but 404'd EVERY /guides/<slug>/ and EVERY /go/<id>/ affiliate cloak — the
# whole guide surface and the whole revenue surface. `wrangler deploy` reported
# success, deploy.sh cleared .deploy-needed, and nothing noticed for ~9 minutes.
#
# The mature sites already resolve the Cloudflare build and compare script
# hashes. That proves the RIGHT BUILD is live; it cannot prove the build SERVES
# ANYTHING. This is the missing half: fetch real routes and assert 200.
#
# Routes are derived from the build output, never hardcoded — a list someone has
# to remember to update goes stale the first time a section is added.
#
#   usage: verify-deploy.sh [--base URL] [--dist DIR] [--quiet]
#   run from the site repo root (or pass --dist)
#
#   exit 0 = edge matches the build
#   exit 1 = it does not — the CALLER MUST NOT clear .deploy-needed
set -uo pipefail

BASE=""; DIST=""; QUIET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)  BASE="$2"; shift 2 ;;
    --dist)  DIST="$2"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    *) shift ;;
  esac
done

SITE_ROOT="$(pwd)"
say() { [[ "$QUIET" -eq 1 ]] || echo "[verify-deploy] $*"; }

# --- Locate the build ------------------------------------------------------
if [[ -z "$DIST" ]]; then
  for c in "$SITE_ROOT/site/dist/client" "$SITE_ROOT/site/dist" "$SITE_ROOT/dist/client" "$SITE_ROOT/dist"; do
    [[ -f "$c/index.html" ]] && { DIST="$c"; break; }
  done
fi
[[ -n "$DIST" && -d "$DIST" ]] || { say "no build output found — skipping (nothing to verify against)"; exit 0; }

# --- Resolve the base URL --------------------------------------------------
# Order: explicit flag, tracked.yaml, CLAUDE.md, wrangler config, dir name.
# $BASE_URL is already exported by most sites' deploy.sh — prefer it.
[[ -z "$BASE" && -n "${BASE_URL:-}" ]] && BASE="$BASE_URL"
if [[ -z "$BASE" ]]; then
  BASE="$(grep -m1 -oE 'https://[a-z0-9.-]+\.[a-z]{2,}' "$SITE_ROOT/ops/tracked.yaml" 2>/dev/null || true)"
fi
# tracked.yaml often carries a bare `site: example.com` rather than a URL.
if [[ -z "$BASE" ]]; then
  d="$(grep -m1 -oE '^site: *[a-z0-9.-]+\.[a-z]{2,}' "$SITE_ROOT/ops/tracked.yaml" 2>/dev/null | sed -E 's/^site: *//' || true)"
  [[ -n "$d" ]] && BASE="https://$d"
fi
# In the worker container SITE_ROOT is /work, so basename yields "work", not a
# domain — wrangler config is the reliable in-container source.
if [[ -z "$BASE" ]]; then
  d="$(grep -m1 -oE '"name" *: *"[a-z0-9-]+"' "$SITE_ROOT/site/wrangler.jsonc" "$SITE_ROOT/site/wrangler.json" 2>/dev/null \
       | head -1 | sed -E 's/.*: *"//; s/"$//' || true)"
  # Workers strip dots from the zone: eastcoastrappers-com -> eastcoastrappers.com
  [[ -n "$d" ]] && BASE="https://$(echo "$d" | sed -E 's/-(com|org|net|io|co)$/.\1/')"
fi
if [[ -z "$BASE" ]]; then
  BASE="$(grep -m1 -oE 'https://[a-z0-9.-]+\.[a-z]{2,}' "$SITE_ROOT/CLAUDE.md" 2>/dev/null || true)"
fi
if [[ -z "$BASE" ]]; then
  d="$(basename "$SITE_ROOT")"
  [[ "$d" == *.* ]] && BASE="https://$d"
fi
[[ -n "$BASE" ]] || { say "could not resolve a base URL — skipping"; exit 0; }
BASE="${BASE%/}"

# --- Derive the route sample ----------------------------------------------
# Every top-level section index, plus first+last of the two deepest collections
# and of any affiliate cloak directory. Bounded on purpose: this is a gate that
# runs on every deploy, not a crawl (the affiliate sentinel does that daily).
mapfile -t ROUTES < <(
  {
    echo "/"
    for d in "$DIST"/*/; do
      name="$(basename "$d")"
      # `api` is excluded everywhere: endpoints are frequently POST-only or
      # non-200 on a bare GET, so a 404 there says nothing about the deploy.
      case "$name" in _astro|images|assets|fonts|media|api|.*) continue ;; esac
      [[ -f "$d/index.html" ]] && echo "/$name/"
    done
    # Deep sample: for each section that contains child directories, take the
    # first and last child — catches "index renders, children 404".
    for d in "$DIST"/*/; do
      name="$(basename "$d")"
      case "$name" in _astro|images|assets|fonts|media|api|og|.*) continue ;; esac
      # A child only counts if it is a real PAGE. Directories under a section are
      # frequently asset folders (rodhat's posts/<slug>/ holds card.jpg + cover.jpg
      # and no HTML) or dynamic-route stubs (sinderella's og/<param>/), and
      # treating those as routes produced confident 404s against healthy sites.
      children="$(find "$d" -mindepth 1 -maxdepth 1 -type d 2>/dev/null \
                  -exec test -f '{}/index.html' \; -printf '%f\n' | sort)"
      [[ -z "$children" ]] && continue
      echo "$children" | head -1 | sed "s|^|/$name/|; s|$|/|"
      echo "$children" | tail -1 | sed "s|^|/$name/|; s|$|/|"
    done
  } | awk 'NF' | sort -u
)

[[ "${#ROUTES[@]}" -gt 0 ]] || { say "no routes derived from $DIST — skipping"; exit 0; }

say "checking ${#ROUTES[@]} route(s) against $BASE"
FAILED=()
for r in "${ROUTES[@]}"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${BASE}${r}" 2>/dev/null)"
  # Two retries with backoff. A single retry was not enough: 000 (connection
  # refused / DNS) shows up under request volume and during edge propagation,
  # and a verifier that cries wolf on those gets switched off.
  for delay in 3 8; do
    [[ "$code" == "200" ]] && break
    sleep "$delay"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${BASE}${r}" 2>/dev/null)"
  done
  code="${code:-000}"
  [[ "$code" == "200" ]] || { FAILED+=("$r=$code"); say "FAIL $r -> $code"; }
done

if [[ "${#FAILED[@]}" -eq 0 ]]; then
  say "OK — ${#ROUTES[@]}/${#ROUTES[@]} route(s) serving 200"
  exit 0
fi

SITE="$(basename "$SITE_ROOT")"
MSG=":rotating_light: ${SITE} deploy verification FAILED — ${#FAILED[@]}/${#ROUTES[@]} route(s) not 200 after deploy: ${FAILED[*]}. The build exists but the edge is not serving it. .deploy-needed left in place for retry."
say "$MSG"

# Best-effort alerting — never let a notifier problem mask the verdict.
CHANNEL="$(grep -m1 -oE 'SLACK_CHANNEL_[A-Z0-9_]+' "$SITE_ROOT/ops/scripts/run-role.sh" 2>/dev/null || true)"
CHANNEL_VAL="${!CHANNEL:-}"
[[ -z "$CHANNEL_VAL" ]] && CHANNEL_VAL="domain-$(echo "$SITE" | tr '.' '-')"
[[ -x "$SITE_ROOT/ops/scripts/notify-slack.sh" ]] && \
  bash "$SITE_ROOT/ops/scripts/notify-slack.sh" "$CHANNEL_VAL" "$MSG" danger >/dev/null 2>&1 || true
[[ -x "$SITE_ROOT/ops/scripts/emit-incident.sh" ]] && \
  bash "$SITE_ROOT/ops/scripts/emit-incident.sh" "deploy-verification" "$MSG" >/dev/null 2>&1 || true

exit 1
