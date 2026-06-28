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
  python3 - "$BASE_URL" "$REPO_ROOT/$ARTICLES_DIR_REL" <<'PY'
import os, sys, re, urllib.request, urllib.error

base, articles_dir = sys.argv[1], sys.argv[2]
fields      = os.environ.get("IMAGE_FIELDS", "image imageCard").split()
check_webp  = os.environ.get("CHECK_WEBP", "1") == "1"
FLOOR = {"cover": int(os.environ.get("COVER_FLOOR", "11000")),
         "card":  int(os.environ.get("CARD_FLOOR",  "6000"))}
UA = os.environ.get("UA", "ImageWatchdog/1.0")

def role_for(field):
    # "image" is the hero/cover; everything else (imageCard, ...) is a card.
    return "cover" if field == "image" else "card"

def head(url):
    """Return (status, content_length). Cloudflare omits Content-Length on HEAD
    for static assets, so we GET and read the header without downloading the
    body (connection is closed before the body is read)."""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            cl = r.headers.get("Content-Length")
            return r.status, int(cl) if cl and cl.isdigit() else -1
    except urllib.error.HTTPError as e:
        return e.code, -1
    except Exception:
        return 0, -1  # network/DNS/timeout

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
    # A published article missing a configured image field renders with no hero
    # and the default og-image. Probing only paths that EXIST in frontmatter is a
    # blind spot — a missing field contributes 0 to CHECKED and can never be a
    # FAILURE. Flag each missing field directly so collection gaps get found.
    for field in fields:
        if field not in fm:
            checked += 1
            failures.append((slug, "(no %s: frontmatter)" % field,
                             "missing %s frontmatter" % field))
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
        status, size = head(url)
        if status != 200:
            failures.append((slug, path, "HTTP %s" % (status or "unreachable")))
        elif path.endswith(".jpg") and size != -1 and size < FLOOR[role]:
            failures.append((slug, path, "blank? %d bytes < %d floor" % (size, FLOOR[role])))

print("CHECKED %d" % checked)
print("FAILURES %d" % len(failures))
for slug, path, reason in failures[:40]:
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
