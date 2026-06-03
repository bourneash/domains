#!/usr/bin/env bash
# deploy-probe.sh — verify Cloudflare push-to-deploy wiring across every site repo.
#
# WHAT IT DOES
#   For each site submodule under sites/<domain>:
#     1. Bumps a serial number in a small root-level probe file (.deploy-probe),
#        creating it on first run.
#     2. Commits ONLY that file and pushes to main, which kicks off the repo's
#        Cloudflare Workers Build (push-to-deploy).
#     3. (optional --verify) Records the worker's current version BEFORE the push
#        and polls afterwards to confirm Cloudflare actually shipped a new version.
#   Finally prints a Markdown table: site, serial, status, worker, deploy result,
#   and a link to the repo + the triggering commit so you can validate in the
#   Cloudflare dashboard.
#
#   The whole point is diagnostic: any repo that pushes but never gets a new
#   worker version is a misconfigured / unconnected Workers Build — exactly what
#   we're hunting for.
#
# SAFETY — never disturbs in-flight work. A repo is SKIPPED (not modified) if:
#     - it is not on the `main` branch (feature work checked out)
#     - its working tree is dirty (uncommitted edits in flight)
#     - its local main has diverged from / is ahead of origin/main (unpushed work)
#     - the push is rejected by a concurrent update (our probe commit is rolled back)
#   Only the probe file is ever staged (never `git add -A`), so unrelated changes
#   can never be swept into a probe commit.
#
# USAGE
#   bash tools/deployment-tester/deploy-probe.sh [options]
#
#   --list                 List eligible repos and exit (no writes).
#   --dry-run              Show what would be bumped/pushed, but make no changes.
#   --verify               After pushing, poll each worker to confirm a new
#                          version shipped (uses the CF API + .env token).
#   --verify-timeout SECS  Max seconds to wait for deploys in --verify (default 360).
#   --delay SECS           Pause between repos to avoid hammering (default 5).
#   --only "a.com b.com"   Restrict to a space-separated set of domains.
#   --probe-file NAME      Probe filename at repo root (default .deploy-probe).
#   -h | --help            This help.
#
# Exit code is 0 unless a usage error occurs; per-repo problems are reported in
# the table, not via exit status, so a single misconfigured repo never aborts the run.

set -uo pipefail   # deliberately NOT -e: we handle per-repo failures and continue

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EXCLUDE_FILE="${SCRIPT_DIR}/exclude.txt"

# ---- defaults ----------------------------------------------------------------
DELAY=5
DO_VERIFY=0
VERIFY_TIMEOUT=360
DRY_RUN=0
LIST_ONLY=0
PROBE_FILE=".deploy-probe"
ONLY_SET=""

# ---- arg parsing -------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --list)           LIST_ONLY=1 ;;
    --dry-run)        DRY_RUN=1 ;;
    --verify)         DO_VERIFY=1 ;;
    --verify-timeout) VERIFY_TIMEOUT="${2:?}"; shift ;;
    --delay)          DELAY="${2:?}"; shift ;;
    --only)           ONLY_SET="${2:?}"; shift ;;
    --probe-file)     PROBE_FILE="${2:?}"; shift ;;
    -h|--help)        sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

# CF creds only needed for --verify; load lazily so non-verify runs need no token.
if [ "${DO_VERIFY}" = "1" ]; then
  if [ -f "${DOMAINS_ROOT}/.env" ]; then
    set -a; . "${DOMAINS_ROOT}/.env"; set +a
  else
    echo "WARN: --verify requested but ${DOMAINS_ROOT}/.env not found; skipping verification." >&2
    DO_VERIFY=0
  fi
fi

# ---- load exclusion set ------------------------------------------------------
declare -A EXCLUDED=()
if [ -f "${EXCLUDE_FILE}" ]; then
  while IFS= read -r line; do
    line="${line%%#*}"; line="$(echo "$line" | tr -d '[:space:]')"
    [ -n "$line" ] && EXCLUDED["$line"]=1
  done < "${EXCLUDE_FILE}"
fi

# ---- helpers -----------------------------------------------------------------

# worker name: prefer the authoritative name in site/wrangler.jsonc, else dot->dash
worker_name_for() {
  local dir="$1" domain="$2" wn=""
  if [ -f "${dir}/site/wrangler.jsonc" ]; then
    wn="$(grep -m1 '"name"' "${dir}/site/wrangler.jsonc" \
          | sed -E 's/.*"name"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')"
  fi
  [ -n "$wn" ] && printf '%s' "$wn" || printf '%s' "${domain//./-}"
}

# github https url from the submodule's origin remote (repo name may differ from domain)
repo_url_for() {
  local dir="$1" remote
  remote="$(git -C "$dir" remote get-url origin 2>/dev/null)" || return 0
  # git@host:owner/repo.git  |  https://host/owner/repo.git  ->  owner/repo
  local path
  path="$(printf '%s' "$remote" | sed -E 's#^[^@]+@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##')"
  printf 'https://github.com/%s' "$path"
}

# current top version id for a worker (empty on any failure / missing worker)
worker_version() {
  local worker="$1"
  [ "${DO_VERIFY}" = "1" ] || return 0
  /usr/bin/curl -fsS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker}/versions" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" 2>/dev/null \
    | /usr/bin/python3 -c 'import json,sys
try:
    print(json.load(sys.stdin)["result"]["items"][0]["id"])
except Exception:
    print("")' 2>/dev/null
}

# ---- discover repos ----------------------------------------------------------
mapfile -t SUBMODULE_PATHS < <(git -C "${DOMAINS_ROOT}" config -f .gitmodules --get-regexp 'path' \
  | awk '{print $2}' | grep '^sites/' | sort -u)

# results accumulate as TSV: status<TAB>domain<TAB>serial<TAB>sha<TAB>worker<TAB>repo_url<TAB>baseline<TAB>deploy
RESULTS="$(mktemp)"
trap 'rm -f "${RESULTS}"' EXIT

record() { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >> "${RESULTS}"; }

in_only() {
  [ -z "${ONLY_SET}" ] && return 0
  local d="$1"; for x in ${ONLY_SET}; do [ "$x" = "$d" ] && return 0; done; return 1
}

# ---- list mode ---------------------------------------------------------------
if [ "${LIST_ONLY}" = "1" ]; then
  echo "Eligible site repos (${#SUBMODULE_PATHS[@]} submodules; excludes apply):"
  for p in "${SUBMODULE_PATHS[@]}"; do
    d="$(basename "$p")"
    tag=""
    [ -n "${EXCLUDED[$d]:-}" ] && tag=" [EXCLUDED]"
    in_only "$d" || tag=" [filtered-out by --only]"
    br="$(git -C "${DOMAINS_ROOT}/$p" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    printf '  %-28s branch=%-34s%s\n' "$d" "$br" "$tag"
  done
  exit 0
fi

echo "=== deploy-probe — $( [ "${DRY_RUN}" = 1 ] && echo DRY-RUN || echo LIVE ) ==="
echo "  repos: ${#SUBMODULE_PATHS[@]}   delay: ${DELAY}s   verify: $( [ "${DO_VERIFY}" = 1 ] && echo on || echo off )"
echo ""

# ---- main loop: trigger ------------------------------------------------------
TOTAL="${#SUBMODULE_PATHS[@]}"
idx=0
for p in "${SUBMODULE_PATHS[@]}"; do
  idx=$((idx+1))
  domain="$(basename "$p")"
  dir="${DOMAINS_ROOT}/$p"

  in_only "$domain" || continue

  if [ -n "${EXCLUDED[$domain]:-}" ]; then
    record "excluded" "$domain" "-" "-" "-" "$(repo_url_for "$dir")" "" ""
    echo "  - ${domain}: excluded"
    continue
  fi

  # must be a real git repo
  if ! git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
    record "skip:not-a-repo" "$domain" "-" "-" "-" "" "" ""
    echo "  ! ${domain}: not a git repo — skipped"
    continue
  fi

  repo_url="$(repo_url_for "$dir")"
  worker="$(worker_name_for "$dir" "$domain")"

  # must be on main
  branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ "$branch" != "main" ]; then
    record "skip:not-main" "$domain" "-" "-" "$worker" "$repo_url" "" ""
    echo "  ~ ${domain}: on '${branch}', not main — skipped (in-flight)"
    continue
  fi

  # refresh remote tracking (best effort)
  git -C "$dir" fetch -q origin main 2>/dev/null || true

  # working tree must be clean (protect in-flight uncommitted edits)
  if [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then
    record "skip:dirty" "$domain" "-" "-" "$worker" "$repo_url" "" ""
    echo "  ~ ${domain}: dirty working tree — skipped (in-flight)"
    continue
  fi

  # local main must equal or trail origin/main (never push someone's unpushed work)
  local_sha="$(git -C "$dir" rev-parse main 2>/dev/null)"
  remote_sha="$(git -C "$dir" rev-parse origin/main 2>/dev/null || echo '')"
  if [ -z "$remote_sha" ]; then
    record "skip:no-remote-main" "$domain" "-" "-" "$worker" "$repo_url" "" ""
    echo "  ! ${domain}: no origin/main — skipped"
    continue
  fi
  if [ "$local_sha" != "$remote_sha" ]; then
    base="$(git -C "$dir" merge-base main origin/main 2>/dev/null || echo '')"
    if [ "$local_sha" = "$base" ]; then
      # local behind -> fast-forward to origin before adding our commit
      # (don't mutate anything in dry-run; the would-push report is enough)
      if [ "${DRY_RUN}" != "1" ]; then
        git -C "$dir" merge --ff-only -q origin/main 2>/dev/null || {
          record "skip:ff-failed" "$domain" "-" "-" "$worker" "$repo_url" "" ""
          echo "  ! ${domain}: could not fast-forward — skipped"; continue; }
      fi
    else
      record "skip:diverged" "$domain" "-" "-" "$worker" "$repo_url" "" ""
      echo "  ~ ${domain}: local main ahead of / diverged from origin — skipped (unpushed work)"
      continue
    fi
  fi

  # compute next serial
  cur=0
  if [ -f "${dir}/${PROBE_FILE}" ]; then
    cur="$(grep -m1 '^serial=' "${dir}/${PROBE_FILE}" | cut -d= -f2 | tr -dc '0-9')"
    [ -z "$cur" ] && cur=0
  fi
  next=$((cur+1))

  if [ "${DRY_RUN}" = "1" ]; then
    record "dry-run" "$domain" "$next" "-" "$worker" "$repo_url" "" ""
    echo "  · ${domain}: would bump serial ${cur} -> ${next} and push"
    continue
  fi

  # baseline worker version BEFORE the push (for --verify)
  baseline="$(worker_version "$worker")"

  # write probe file (this is the ONLY file we touch)
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat > "${dir}/${PROBE_FILE}" <<EOF
# deploy-probe — managed by tools/deployment-tester. Safe to delete.
# Bumping the serial and pushing to main triggers a Cloudflare Workers Build,
# letting us confirm push-to-deploy is wired correctly for this repo.
serial=${next}
updated=${ts}
EOF

  git -C "$dir" add -- "${PROBE_FILE}"
  if ! git -C "$dir" -c commit.gpgsign=false commit -q \
        -m "chore(deploy-probe): serial ${next} — verify CF push-to-deploy"; then
    git -C "$dir" checkout -q -- "${PROBE_FILE}" 2>/dev/null || true
    record "skip:commit-failed" "$domain" "$next" "-" "$worker" "$repo_url" "" ""
    echo "  ! ${domain}: commit failed — skipped"
    continue
  fi

  if ! git -C "$dir" push -q origin main 2>/dev/null; then
    # concurrent push won the race — roll our probe commit back cleanly
    git -C "$dir" fetch -q origin main 2>/dev/null || true
    git -C "$dir" reset --hard -q origin/main 2>/dev/null || true
    record "skip:push-rejected" "$domain" "$next" "-" "$worker" "$repo_url" "" ""
    echo "  ~ ${domain}: push rejected (concurrent update) — rolled back, skipped"
    continue
  fi

  sha="$(git -C "$dir" rev-parse --short HEAD)"
  record "pushed" "$domain" "$next" "$sha" "$worker" "$repo_url" "$baseline" "pending"
  echo "  ✓ ${domain}: serial ${next} pushed (${sha}) — build triggered"

  # polite delay between repos (skip after the last one)
  if [ "$idx" -lt "$TOTAL" ] && [ "${DELAY}" -gt 0 ]; then
    sleep "${DELAY}"
  fi
done

# ---- verification phase ------------------------------------------------------
if [ "${DO_VERIFY}" = "1" ]; then
  echo ""
  echo "=== verifying deploys (timeout ${VERIFY_TIMEOUT}s) ==="
  deadline=$(( $(date +%s) + VERIFY_TIMEOUT ))
  # iterate until all pushed-with-worker rows resolve, or timeout
  while :; do
    pending=0
    # rewrite RESULTS with updated deploy column
    NEW="$(mktemp)"
    while IFS=$'\t' read -r status domain serial sha worker repo_url baseline deploy; do
      if [ "$status" = "pushed" ] && [ "$deploy" = "pending" ]; then
        if [ -z "$baseline" ]; then
          deploy="no-worker"          # never had a version to compare -> not deployed via a worker
        else
          cur="$(worker_version "$worker")"
          if [ -n "$cur" ] && [ "$cur" != "$baseline" ]; then
            deploy="ok:${cur}"
          else
            deploy="pending"; pending=$((pending+1))
          fi
        fi
      fi
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$status" "$domain" "$serial" "$sha" "$worker" "$repo_url" "$baseline" "$deploy" >> "$NEW"
    done < "${RESULTS}"
    mv "$NEW" "${RESULTS}"

    [ "$pending" -eq 0 ] && break
    if [ "$(date +%s)" -ge "$deadline" ]; then
      # mark the stragglers as timed out
      NEW="$(mktemp)"
      while IFS=$'\t' read -r status domain serial sha worker repo_url baseline deploy; do
        [ "$deploy" = "pending" ] && deploy="no-new-version"
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
          "$status" "$domain" "$serial" "$sha" "$worker" "$repo_url" "$baseline" "$deploy" >> "$NEW"
      done < "${RESULTS}"
      mv "$NEW" "${RESULTS}"
      break
    fi
    echo "  …${pending} still building, re-checking in 15s"
    sleep 15
  done
fi

# ---- render Markdown table ---------------------------------------------------
echo ""
VERIFY_ON="${DO_VERIFY}" /usr/bin/python3 - "${RESULTS}" <<'PY'
import sys, os
rows = []
with open(sys.argv[1]) as f:
    for line in f:
        parts = line.rstrip("\n").split("\t")
        while len(parts) < 8: parts.append("")
        rows.append(parts)
verify = os.environ.get("VERIFY_ON") == "1"

def deploy_cell(status, baseline, deploy):
    if status != "pushed":
        return "—"
    if deploy.startswith("ok:"):
        return f"✅ new `{deploy[3:][:8]}`"
    if deploy == "no-worker":
        return "⚠️ no worker found"
    if deploy == "no-new-version":
        return "❌ **no new version**"
    if deploy == "pending":
        return "⏳ pending"
    return deploy or "—"

STATUS_LABEL = {
    "pushed": "✅ pushed",
    "excluded": "⏭️ excluded",
    "skip:not-main": "⏸️ not on main",
    "skip:dirty": "⏸️ dirty tree",
    "skip:diverged": "⏸️ diverged",
    "skip:not-a-repo": "⚠️ not a repo",
    "skip:no-remote-main": "⚠️ no origin/main",
    "skip:ff-failed": "⚠️ ff failed",
    "skip:commit-failed": "⚠️ commit failed",
    "skip:push-rejected": "⏸️ push rejected",
    "dry-run": "· dry-run",
}

# header
cols = ["Site", "Serial", "Status"]
if verify: cols.append("Deploy")
cols += ["Worker", "Repo / commit"]
print("| " + " | ".join(cols) + " |")
print("|" + "|".join(["---"]*len(cols)) + "|")

def repo_link(domain, repo_url, sha):
    if not repo_url:
        return domain
    owner_repo = repo_url.rsplit("/",1)[-1]
    label = repo_url.replace("https://github.com/","")
    if sha and sha != "-":
        return f"[{label}]({repo_url}) · [`{sha}`]({repo_url}/commit/{sha})"
    return f"[{label}]({repo_url})"

# sort: pushed first, then skips, then excluded; alpha within
order = {"pushed":0, "dry-run":1}
def keyf(r):
    s = r[0]
    grp = order.get(s, 2 if s.startswith("skip") else 3)
    return (grp, r[1])

counts = {}
for r in sorted(rows, key=keyf):
    status, domain, serial, sha, worker, repo_url, baseline, deploy = r
    counts[status] = counts.get(status,0)+1
    cells = [domain, serial if serial!="-" else "—", STATUS_LABEL.get(status, status)]
    if verify: cells.append(deploy_cell(status, baseline, deploy))
    cells += [f"`{worker}`" if worker not in ("-","") else "—", repo_link(domain, repo_url, sha)]
    print("| " + " | ".join(cells) + " |")

print()
pushed = counts.get("pushed",0)
summary = [f"**{pushed} pushed**"]
skipped = sum(v for k,v in counts.items() if k.startswith("skip"))
if skipped: summary.append(f"{skipped} skipped (in-flight/misconfig)")
if counts.get("excluded"): summary.append(f"{counts['excluded']} excluded")
if counts.get("dry-run"): summary.append(f"{counts['dry-run']} would-push (dry-run)")
print("Summary: " + " · ".join(summary))
if verify:
    bad = sum(1 for r in rows if r[0]=="pushed" and (r[7]=="no-new-version" or r[7]=="no-worker"))
    if bad:
        print(f"\n⚠️ **{bad} repo(s) pushed but Cloudflare never shipped a new version** — likely Workers Builds not connected. Investigate these first.")
PY
