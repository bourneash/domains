---
name: ultrarough.com-bind-domains
description: One-shot post-Worker-creation skill for ultrarough.com. After Jesse creates the `ultrarough` Worker in the Cloudflare dashboard via Connect-to-Git, this skill binds the apex + www custom domains, waits for DNS propagation, runs the live smoke test against https://ultrarough.com, and logs go-live to the BOARD_REPORT. Run once per environment. Idempotent — safe to re-run if a domain didn't bind the first time.
---

# ultrarough.com — bind custom domains + go-live verification

You are running the post-Worker-creation handoff. Jesse already clicked through the Cloudflare dashboard to create the `ultrarough` Worker connected to `bourneash/ultrarough.com`. Your job is to bind the apex + www domains via the Workers Domains API and confirm the site is live at https://ultrarough.com.

> Naming convention: per-domain skills are named `<domain>-<purpose>` (e.g., `aliencouncil.com-update`, `ultrarough.com-bind-domains`).

## Project facts (do not look these up)

- Project root: `/home/jesse/projects/domains/ultrarough.com/`
- Worker name: `ultrarough`
- Repo: github.com/bourneash/ultrarough.com (private), branch `main`
- CF Zone ID: `980e286d87a8179086452f0b7c22fdc8`
- CF Account ID: read from `/home/jesse/projects/domains/.env` (`CLOUDFLARE_ACCOUNT_ID`)
- Token scopes confirmed working (memory `reference_cf_token_scopes.md`): Workers Domains:Edit, DNS:Edit, Email Routing
- **Token has no Pages scope. Don't use Pages endpoints.**
- Sandbox blocks port 53 — use DoH for DNS lookup (`https://cloudflare-dns.com/dns-query`)
- Hosts to bind: `ultrarough.com` (apex) + `www.ultrarough.com`

## Pre-flight

```bash
cd /home/jesse/projects/domains/ultrarough.com
set -a; . /home/jesse/projects/domains/.env; set +a
test -n "$CLOUDFLARE_API_TOKEN" && test -n "$CLOUDFLARE_ACCOUNT_ID" && echo "creds ok"
```

If creds are missing, stop. Don't proceed without them.

## Step 1 — confirm the Worker exists

The Worker must exist in the CF account before binding domains. Verify:

```bash
/usr/bin/curl -sS \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/ultrarough" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); ok=d.get("success"); print("worker exists" if ok else "WORKER MISSING — Jesse needs to create it via Connect-to-Git first"); sys.exit(0 if ok else 1)'
```

If `WORKER MISSING`: the Connect-to-Git step in CF dashboard hasn't completed yet. **Do not proceed.** Surface a one-line message: "Worker `ultrarough` not yet created in CF — finish the dashboard step first." and stop.

## Step 2 — bind the apex + www custom domains

Workers Domains API. PUTs are idempotent — safe if a binding already exists.

```bash
ZONE_ID=980e286d87a8179086452f0b7c22fdc8
for HOST in ultrarough.com www.ultrarough.com; do
  /usr/bin/curl -sS -X PUT \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"environment\":\"production\",\"hostname\":\"${HOST}\",\"service\":\"ultrarough\",\"zone_id\":\"${ZONE_ID}\"}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print('  ${HOST}:', 'success' if d.get('success') else d.get('errors'))"
done
```

CF auto-creates `AAAA 100::` proxied=true on both apex + www. Propagation is ~30 seconds.

## Step 3 — wait for DNS propagation (DoH-aware)

Sandbox blocks port-53 DNS. Use Cloudflare DoH instead.

```bash
for i in 1 2 3 4 5 6; do
  APEX_IP=$(/usr/bin/curl -sS -H "accept: application/dns-json" \
    "https://cloudflare-dns.com/dns-query?name=ultrarough.com&type=A" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); ans=d.get("Answer") or []; print(ans[0]["data"] if ans else "")')
  if [[ -n "$APEX_IP" ]]; then echo "apex resolved to $APEX_IP after ${i}0s"; break; fi
  sleep 10
done
```

If `APEX_IP` is empty after 60s, propagation is slow but binding is done. Continue to step 4 — Cloudflare's edge will route correctly even if your DNS resolver hasn't caught up.

## Step 4 — live smoke test

```bash
APEX_IP=$(/usr/bin/curl -sS -H "accept: application/dns-json" \
  "https://cloudflare-dns.com/dns-query?name=ultrarough.com&type=A" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); ans=d.get("Answer") or []; print(ans[0]["data"] if ans else "104.21.0.1")')

echo "=== smoke test on https://ultrarough.com (resolved $APEX_IP) ==="
PATHS=(
  "/"
  "/reviews/"
  "/reviews/3m-pro-grade-assorted/"
  "/grit/"
  "/grit/220/"
  "/forms/"
  "/forms/disc/"
  "/grit-selector/"
  "/guides/sandpaper-grit-chart/"
  "/about/"
  "/disclosure/"
  "/contact/"
  "/rss.xml"
  "/sitemap-index.xml"
  "/favicon.svg"
)
PASS=0; FAIL=0
for path in "${PATHS[@]}"; do
  code=$(/usr/bin/curl -sS -o /dev/null -L -w "%{http_code}" \
    --resolve "ultrarough.com:443:${APEX_IP}" \
    "https://ultrarough.com${path}")
  if [[ "$code" =~ ^2 ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
  echo "  HTTP ${code}  ${path}"
done

# Affiliate redirect: should 30x to amazon.com/s?...&tag=ultrarough-20
code=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" \
  --resolve "ultrarough.com:443:${APEX_IP}" \
  "https://ultrarough.com/go/3m-pro-grade-assorted")
target=$(/usr/bin/curl -sS -o /dev/null -w "%{redirect_url}" \
  --resolve "ultrarough.com:443:${APEX_IP}" \
  "https://ultrarough.com/go/3m-pro-grade-assorted")
echo "  HTTP ${code}  /go/3m-pro-grade-assorted → ${target}"
[[ "$target" == *"tag=ultrarough-20"* ]] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

# www redirect: should 200 from www.ultrarough.com
WWW_IP=$(/usr/bin/curl -sS -H "accept: application/dns-json" \
  "https://cloudflare-dns.com/dns-query?name=www.ultrarough.com&type=A" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); ans=d.get("Answer") or []; print(ans[0]["data"] if ans else "")')
if [[ -n "$WWW_IP" ]]; then
  wcode=$(/usr/bin/curl -sS -o /dev/null -L -w "%{http_code}" \
    --resolve "www.ultrarough.com:443:${WWW_IP}" \
    "https://www.ultrarough.com/")
  echo "  HTTP ${wcode}  https://www.ultrarough.com/"
  [[ "$wcode" =~ ^2 ]] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
fi

echo ""
echo "=== ${PASS} pass / ${FAIL} fail ==="
```

If FAIL > 0: dump first failure verbose (`-v`) for diagnosis. Don't bail on 1 fail; CF edge can be flaky for ~60s after first deploy.

## Step 5 — verify security headers

```bash
APEX_IP=$(/usr/bin/curl -sS -H "accept: application/dns-json" "https://cloudflare-dns.com/dns-query?name=ultrarough.com&type=A" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("Answer") or [{}])[0].get("data",""))')
/usr/bin/curl -sSI --resolve "ultrarough.com:443:${APEX_IP}" "https://ultrarough.com/" \
  | grep -iE "^(strict-transport-security|content-security-policy|x-content-type-options|x-frame-options|referrer-policy):"
```

Expect 5 headers. If any missing, the `_headers` file didn't ship with the build — flag it.

## Step 6 — log go-live to BOARD_REPORT

Prepend a new section to `ops/board/BOARD_REPORT.md` with today's date, the workers.dev URL (if known), and the smoke-test pass/fail count. Example:

```markdown
## YYYY-MM-DD — LIVE at ultrarough.com

Custom domains bound. {N}/{N} smoke tests pass on https://ultrarough.com.
Worker: `ultrarough` (workers.dev URL: ...)

### Now blocked on Jesse
- File Amazon Associates application at https://affiliate-program.amazon.com (tracking ID: ultrarough-20, already wired into the site).
- Verify Google Search Console site ownership and submit the sitemap.
- Create Instagram + TikTok accounts (see CREDENTIALS_NEEDED.md).
```

Commit the board report change with a clear message. Don't push here — the deployer role handles deploys via the `.deploy-needed` flag, but a board update doesn't trigger a rebuild so we can push directly.

```bash
cd /home/jesse/projects/domains/ultrarough.com
git add ops/board/BOARD_REPORT.md
git -c commit.gpgsign=false commit -q -m "BOARD: ultrarough.com live at https://ultrarough.com"
git push origin main
```

## Step 7 — surface the result

Print a tight summary back to Jesse:

- Live URL + pass/fail counts
- Affiliate redirect verified (`/go/3m-pro-grade-assorted` → `tag=ultrarough-20`)
- Security headers count (expect 5)
- The 3 follow-on items now blocked on him: Amazon Associates application, GSC verification, Instagram/TikTok account creation

## Common failure modes

- **Worker missing**: stop, ask Jesse to finish Connect-to-Git in CF dashboard.
- **Domain binding 409 (already bound)**: ignore, that's idempotent success.
- **Smoke test 404 on `/reviews/<id>/`**: CF Worker static-assets `html_handling: auto-trailing-slash` should resolve this — confirm `wrangler.jsonc` has that flag. Rebuild + redeploy if missing.
- **`/go/<id>` returns 200 instead of 30x**: `_redirects` didn't ship with the build. Confirm `site/public/_redirects` exists, rebuild, redeploy.
- **Email Routing rules dropped**: Re-run the email-routing block from `deploy-domain-project` skill (rules are persistent, but if the zone's MX records were touched manually, re-enable).
