#!/usr/bin/env bash
# check-live-images.sh — live image-loading watchdog (portable template).
#
# For every published article it resolves the referenced hero/card images from
# frontmatter (the fields named in IMAGE_FIELDS, plus optional .webp siblings
# the browser fetches first when CHECK_WEBP=1) and verifies each on the LIVE
# site:
#   - returns HTTP 200, and
#   - is not blank/near-empty (cover ≥ COVER_FLOOR, card ≥ CARD_FLOOR bytes).
#
# Any failure is logged and posted to Slack so the team can fix it fast.
# Runs inside the cron container with only bash + python3 + curl (no node).
# If the site is unreachable it logs a warning and exits 0 (non-fatal).
#
# Grace/propagation retry: a just-deployed image can briefly 404/blank while
# Cloudflare Workers Builds finishes propagating. Failures are re-probed every
# IMAGE_CHECK_GRACE seconds (default 20) for up to IMAGE_CHECK_MAX_WAIT seconds
# (default 200) before being reported, exiting early once everything clears.
# Ported from americastrikes.com's check-live-images.sh (2026-06-22 fix) via
# saveusfarms.com (2026-08-24) — without it, a post-deploy Slack card
# (share-new-articles-slack.sh) races the CDN and posts with its image
# silently dropped (Slack invalid_blocks).
#
# Usage:
#   ops/scripts/check-live-images.sh [BASE_URL]
#       BASE_URL — defaults to BASE_URL_DEFAULT below.
#
# Exit codes: 0 = all good (or site unreachable / Slack unavailable),
#             1 = broken/blank images found.
set -uo pipefail

# ─────────────────────────── PER-SITE CONFIG ────────────────────────────────
# These are the ONLY lines that change between sites. Everything below is
# generic. (Installed by the domains-audit-article-images skill.)
SITE_NAME="example.com"
BASE_URL_DEFAULT="https://example.com"
ARTICLES_DIR_REL="site/src/content/articles"
IMAGE_FIELDS="image imageCard"        # frontmatter keys to check (space-separated)
CHECK_WEBP=1                          # 1 if the build emits .webp siblings the browser fetches; else 0
COVER_FLOOR=11000                     # bytes; below this an "image:" jpg is treated as blank
CARD_FLOOR=6000                       # bytes; below this an "imageCard:" jpg is treated as blank
SLACK_CHANNEL_VAR="SLACK_CHANNEL_EXAMPLE"   # env var name holding the site's channel
SLACK_CHANNEL_DEFAULT="domain-example-com"  # literal fallback channel
UA="ExampleImageWatchdog/1.0 (+https://example.com)"
# Shown to humans on failure — make it the real repair command for THIS site:
REPAIR_HINT="Fix: regenerate the broken image(s), then commit."
# ─────────────────────────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

BASE_URL="${1:-$BASE_URL_DEFAULT}"
BASE_URL="${BASE_URL%/}"

LOG_DIR="$REPO_ROOT/ops/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/image-check-$(date +%Y-%m-%d).log"

# Load shared creds (SLACK_BOT_TOKEN, channel vars) when run from the cron container.
if [ -f ".env.shared" ]; then set -a; . ".env.shared"; set +a; fi

NOTIFY="$REPO_ROOT/ops/scripts/notify-slack.sh"
CHANNEL="$(eval "echo \"\${$SLACK_CHANNEL_VAR:-$SLACK_CHANNEL_DEFAULT}\"")"

# ---- Reachability pre-check: if the site is down, log and exit 0 (non-fatal) ----
HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$BASE_URL/" 2>/dev/null || echo 000)
if [[ ! "$HTTP_CODE" =~ ^2 ]] && [[ ! "$HTTP_CODE" =~ ^3 ]]; then
  echo "[$(date -Iseconds)] image-check: site unreachable ($HTTP_CODE) — skipping" | tee -a "$LOG"
  exit 0
fi

REPORT="$(
  CHECK_WEBP="$CHECK_WEBP" IMAGE_FIELDS="$IMAGE_FIELDS" \
  COVER_FLOOR="$COVER_FLOOR" CARD_FLOOR="$CARD_FLOOR" UA="$UA" \
  IMAGE_HTTP_ATTEMPTS="${IMAGE_HTTP_ATTEMPTS:-3}" \
  python3 - "$BASE_URL" "$REPO_ROOT/$ARTICLES_DIR_REL" <<'PY'
import os, sys, re, time, urllib.request, urllib.error

base, articles_dir = sys.argv[1], sys.argv[2]
fields      = os.environ.get("IMAGE_FIELDS", "image imageCard").split()
check_webp  = os.environ.get("CHECK_WEBP", "1") == "1"
FLOOR = {"cover": int(os.environ.get("COVER_FLOOR", "11000")),
         "card":  int(os.environ.get("CARD_FLOOR",  "6000"))}
UA = os.environ.get("UA", "ImageWatchdog/1.0")
HTTP_ATTEMPTS = max(1, int(os.environ.get("IMAGE_HTTP_ATTEMPTS", "3")))

def role_for(field):
    # "image" is the hero/cover; everything else (imageCard, ...) is a card.
    return "cover" if field == "image" else "card"

def head(url):
    """Return (status, content_length, diagnostic), retrying transient failures.

    A single DNS hiccup or dropped connection must not page as a broken image.
    HTTP 4xx responses are definitive (except 408/429); network failures and
    5xx responses get bounded exponential backoff. Cloudflare omits
    Content-Length on HEAD, so this uses GET without reading the body.
    """
    last_status, last_error = 0, "network error"
    for attempt in range(HTTP_ATTEMPTS):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                cl = r.headers.get("Content-Length")
                return r.status, int(cl) if cl and cl.isdigit() else -1, ""
        except urllib.error.HTTPError as e:
            last_status, last_error = e.code, "HTTP %s" % e.code
        except Exception as e:
            last_status = 0
            last_error = "%s: %s" % (type(e).__name__, str(e).replace("\n", " ")[:160])
        if last_status not in (0, 408, 429) and not (500 <= last_status < 600):
            break
        if attempt + 1 < HTTP_ATTEMPTS:
            time.sleep(0.5 * (2 ** attempt))
    return last_status, -1, "%s after %d attempt(s)" % (last_error, attempt + 1)

def frontmatter(text):
    out = {}
    for key in fields:
        m = re.search(r'(?m)^%s:\s*(.+?)\s*$' % re.escape(key), text)
        if m:
            out[key] = m.group(1).strip().strip('"').strip("'")
    return out

checked = 0
failures = []  # (slug, url, reason)

for fn in sorted(os.listdir(articles_dir)):
    if not fn.endswith(".md"):
        continue
    slug = fn[:-3]
    with open(os.path.join(articles_dir, fn), encoding="utf-8") as f:
        text = f.read()
    fm = frontmatter(text)
    targets = []  # (role, path)
    for field in fields:
        if field not in fm:
            continue
        role = role_for(field)
        targets.append((role, fm[field]))
        if check_webp and fm[field].endswith(".jpg"):
            targets.append((role, re.sub(r'\.jpg$', '.webp', fm[field])))
    for role, path in targets:
        if not path.startswith("/"):
            continue
        url = base + path
        checked += 1
        status, size, diagnostic = head(url)
        if status != 200:
            failures.append((slug, role, path, "HTTP %s" % status if status else "unreachable (%s)" % diagnostic))
        elif path.endswith(".jpg") and size != -1 and size < FLOOR[role]:
            failures.append((slug, role, path, "blank? %d bytes < %d floor" % (size, FLOOR[role])))

# Grace re-check: poll the still-failing images until CF finishes propagating a
# just-pushed deploy, then only report on what's STILL broken. Anything that
# recovers mid-window was a propagation race, not a real break. Re-probes only
# the shrinking set of failures (not the whole site) and stops early the moment
# no real URL is still failing.
def has_live_failure(items):
    return any(path.startswith("/") for _s, _r, path, _reason in items)

GRACE = int(os.environ.get("IMAGE_CHECK_GRACE", "20"))
MAX_WAIT = int(os.environ.get("IMAGE_CHECK_MAX_WAIT", "200"))

if failures and GRACE > 0 and has_live_failure(failures):
    deadline = time.time() + MAX_WAIT
    while has_live_failure(failures) and time.time() < deadline:
        time.sleep(min(GRACE, max(1, int(deadline - time.time()))))
        persistent = []
        for slug, role, path, _old in failures:
            if not path.startswith("/"):
                persistent.append((slug, role, path, _old))
                continue
            status, size, diagnostic = head(base + path)
            reason = None
            if status != 200:
                reason = "HTTP %s" % status if status else "unreachable (%s)" % diagnostic
            elif path.endswith(".jpg") and size != -1 and size < FLOOR[role]:
                reason = "blank? %d bytes < %d floor" % (size, FLOOR[role])
            if reason:
                persistent.append((slug, role, path, reason))
        failures = persistent

print("CHECKED %d" % checked)
print("FAILURES %d" % len(failures))
for slug, role, path, reason in failures[:40]:
    print("FAIL\t%s\t%s\t%s" % (slug, path, reason))
if len(failures) > 40:
    print("... and %d more" % (len(failures) - 40))
PY
)"

echo "[$(date -Iseconds)] image-check against $BASE_URL ($SITE_NAME)" | tee -a "$LOG"
echo "$REPORT" | tee -a "$LOG"

FAIL_COUNT="$(printf '%s\n' "$REPORT" | sed -n 's/^FAILURES \([0-9]*\)$/\1/p')"
FAIL_COUNT="${FAIL_COUNT:-0}"

if [ "$FAIL_COUNT" -gt 0 ]; then
  DETAIL="$(printf '%s\n' "$REPORT" | grep -E '^(FAIL|\.\.\.)' | sed 's/^FAIL\t//; s/\t/  —  /g' | sed 's/^/• /')"
  MSG=":frame_with_picture: *${SITE_NAME}* image watchdog found *${FAIL_COUNT}* broken/blank image(s) on the live site:
${DETAIL}

${REPAIR_HINT}"
  [ -x "$NOTIFY" ] && "$NOTIFY" "$CHANNEL" "$MSG" "danger" 2>/dev/null || true
  exit 1
fi

exit 0
