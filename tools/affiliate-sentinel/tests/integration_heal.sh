#!/usr/bin/env bash
# End-to-end proof of the heal path, against the real Amazon API and a real
# site build — but inside a throwaway clone, so nothing can reach a live site.
#
# WHY THIS EXISTS
# The heal is the only part of the sentinel that writes to a site and queues a
# deploy, and it is the part that runs least: on a healthy fleet it never fires
# at all. That means it can rot silently for months and the first time anyone
# finds out is when a real product dies and the auto-replacement does something
# unintended on a live site. The unit tests cover its logic with stubs; this
# covers the parts stubs cannot — the live searchItems response shape, the
# claude-tracked.sh contract, and whether the edited registry actually builds.
#
# Costs one Sonnet turn per run. Not wired to any cron; run it after touching
# heal.py, registry.py, or amz.py.
#
# Usage: tests/integration_heal.sh [<site>]      (default: reviewtattoo.com)
set -uo pipefail

SITE="${1:-reviewtattoo.com}"
# Exported: the inline python heredocs below import the tool's modules from it.
export TOOL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAINS_ROOT="$(cd "$TOOL_DIR/../.." && pwd)"
SRC="$DOMAINS_ROOT/sites/$SITE"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/affiliate-sentinel-heal.XXXXXX")"
CLONE="$SANDBOX/$SITE"

PASS=0
FAIL=0
ok()   { echo "  ok   $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL $1"; FAIL=$((FAIL+1)); }
cleanup() { [[ -n "${KEEP_SANDBOX:-}" ]] && echo "sandbox kept: $CLONE" || rm -rf "$SANDBOX"; }
trap cleanup EXIT

[[ -d "$SRC" ]] || { echo "no such site: $SRC" >&2; exit 1; }

echo "=== building throwaway clone of $SITE ==="
mkdir -p "$CLONE"
tar --exclude=node_modules --exclude=.git --exclude=dist --exclude=ops/logs \
    -cf - -C "$SRC" . | tar -xf - -C "$CLONE"

# Reuse the real node_modules; a fresh install would take minutes and prove
# nothing extra. The build gate still runs the site's actual build.
rm -rf "$CLONE/site/node_modules"
ln -sfn "$SRC/site/node_modules" "$CLONE/site/node_modules"
# The tools mount the containers get. Also how heal.py finds claude-tracked.sh.
# rm first: the site repo carries .monorepo-tools as a real (empty) mount point,
# and `ln -sfn` will not replace an existing directory — it silently leaves the
# empty dir in place, and the heal then reports "claude-tracked.sh not found".
rm -rf "$CLONE/.monorepo-tools"
ln -sfn "$DOMAINS_ROOT/tools" "$CLONE/.monorepo-tools"
[[ -x "$CLONE/.monorepo-tools/scripts/claude-tracked.sh" ]] || {
  echo "claude-tracked.sh not reachable through the tools symlink" >&2; exit 1; }

# Credentials in the shape the containers see them. Deliberately NO
# SLACK_BOT_TOKEN: a test run must never post into a real site channel.
# The copied .env.shared arrives chmod 400 (fleet rule), so it cannot be
# overwritten in place — drop it and write our own reduced one.
rm -f "$CLONE/.env.shared"
grep -E "^(AMAZON_CREATORS_KEY_ID|AMAZON_CREATORS_KEY_SECRET|AMAZON_ASSOCIATES_STORE_ID)=" \
    "$DOMAINS_ROOT/.env" > "$CLONE/.env.shared" 2>/dev/null
[[ -s "$CLONE/.env.shared" ]] || { echo "no Amazon credentials in $DOMAINS_ROOT/.env" >&2; exit 1; }

git -C "$CLONE" init -q .
git -C "$CLONE" config user.email test@example.com
git -C "$CLONE" config user.name "sentinel integration test"
# No remote at all, so a stray push cannot reach GitHub from here.
echo ".monorepo-tools" >> "$CLONE/.git/info/exclude"

REGISTRY="$(python3 - "$CLONE" <<'PY'
import sys
sys.path.insert(0, __import__("os").environ["TOOL_DIR"])
from pathlib import Path
import registry
r = registry.find_registry(Path(sys.argv[1]))
print(r if r else "")
PY
)"
[[ -n "$REGISTRY" ]] || { echo "no registry found in the clone" >&2; exit 1; }

# Pick a real product and give it an ASIN that is definitively dead: a
# well-formed ASIN that Amazon 404s. Verified to fail BOTH gates (absent from
# getItems AND http-confirmed dead), which is what the heal requires.
DEAD_ASIN="B0CZZZZZZZ"
VICTIM="$(python3 - "$CLONE" "$REGISTRY" "$DEAD_ASIN" <<'PY'
import os, sys
sys.path.insert(0, os.environ["TOOL_DIR"])
from pathlib import Path
import registry
reg = Path(sys.argv[2])
prods = [p for p in registry.parse(reg) if p.asin]
if not prods:
    sys.exit("registry has no ASIN-backed products to test with")
victim = prods[0]
text = reg.read_text()
reg.write_text(text.replace(victim.asin, sys.argv[3]))
# _redirects usually carries a second copy of the ASIN; kill that too so the
# test also exercises the redirect sync.
rp = Path(sys.argv[1]) / "site" / "public" / "_redirects"
if rp.is_file():
    rp.write_text(rp.read_text().replace(victim.asin, sys.argv[3]))
print(f"{victim.id}\t{victim.asin}")
PY
)" || exit 1
VICTIM_ID="${VICTIM%%$'\t'*}"
ORIGINAL_ASIN="${VICTIM##*$'\t'}"
echo "  victim product: $VICTIM_ID (was $ORIGINAL_ASIN, now $DEAD_ASIN)"

# Pre-seed the streak so this run is the SECOND consecutive dead observation —
# the heal deliberately refuses to act on a single sighting.
mkdir -p "$CLONE/ops/state"
printf '{"version": 2, "streaks": {"dead:%s": 1}, "last_run": null}\n' "$VICTIM_ID" \
    > "$CLONE/ops/state/affiliate-sentinel.json"

git -C "$CLONE" add -A >/dev/null 2>&1
git -C "$CLONE" commit -qm "baseline with an injected dead ASIN" >/dev/null 2>&1

echo "=== running the sentinel for real (heal enabled) ==="
python3 "$TOOL_DIR/sentinel.py" --site-root "$CLONE" --site-brand "IntegrationTest" --json \
    > "$SANDBOX/result.json" 2>"$SANDBOX/run.log"
sed 's/^/    /' "$SANDBOX/run.log" | grep -E "heal:|api:|dead streak|cloak:|✅|⚠️|🚨|🔧" || true

echo "=== assertions ==="
python3 - "$SANDBOX/result.json" "$CLONE" "$REGISTRY" "$VICTIM_ID" "$DEAD_ASIN" <<'PY' || exit 1
import json, sys
from pathlib import Path

# sentinel.py tees its progress log to stdout as well as the log file, so the
# --json payload is the trailing object, not the whole stream.
raw = Path(sys.argv[1]).read_text()
start = raw.find("\n{")
result = json.loads(raw[start + 1:] if start != -1 else raw)
clone, reg, vid, dead = Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4], sys.argv[5]
fails = []

def check(name, cond, detail=""):
    print(f"  {'ok  ' if cond else 'FAIL'} {name}{'' if cond else '  ' + str(detail)}")
    if not cond:
        fails.append(name)

healed = result.get("healed") or []
check("the dead ASIN was detected and healed", len(healed) == 1,
      f"healed={healed} unhealed={result.get('unhealed')}")
if healed:
    h = healed[0]
    check("healed the right product", h["product_id"] == vid, h)
    check("chose a different, real ASIN",
          h["new_asin"] and h["new_asin"] != dead, h.get("new_asin"))

    text = reg.read_text()
    check("registry no longer holds the dead ASIN", dead not in text)
    check("registry holds the replacement", h["new_asin"] in text)

    rp = clone / "site" / "public" / "_redirects"
    if rp.is_file():
        rt = rp.read_text()
        check("_redirects no longer holds the dead ASIN", dead not in rt)
        check("_redirects points at the replacement", h["new_asin"] in rt)

check("a deploy was queued", (clone / ".deploy-needed").is_file())
check("the build gate produced a dist/", (clone / "site" / "dist").is_dir())

import subprocess
log = subprocess.run(["git", "-C", str(clone), "log", "--oneline", "-1"],
                     capture_output=True, text=True).stdout
check("the heal was committed", "auto-replace" in log, log.strip())

sys.exit(1 if fails else 0)
PY
rc=$?

echo
if [[ $rc -eq 0 ]]; then
  echo "PASS — heal path verified end to end against the live API and a real build."
else
  echo "FAIL — see $SANDBOX/run.log (re-run with KEEP_SANDBOX=1 to inspect)."
fi
exit $rc
