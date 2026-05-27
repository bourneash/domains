# nsfwpixles.com — Typo Redirect to nsfwpixels.com

This is a **typo-redirect domain**, not a normal site. It has no scaffold, no GitHub
repo, and no Worker. The entire setup lives on Cloudflare's edge — DNS records +
a Single Redirect Rule + Email Routing.

`nsfwpixles` (missing the `i`) → `nsfwpixels` (the canonical site).

## What's deployed where

| Layer | Config |
|---|---|
| DNS | `AAAA nsfwpixles.com -> 100::` (proxied) + `AAAA www.nsfwpixles.com -> 100::` (proxied) — black-hole records that route traffic through CF's edge |
| HTTP redirect | Single Redirect Rule at zone level → `301 https://nsfwpixels.com{path}{query}` |
| Email | CF Email Routing — `contact@`, `takedown@`, catch-all → `jessetamburino@hotmail.com` |

No GitHub repo. No Worker. No Astro. Nothing to build.

## How to verify it's working

```bash
# Apex
curl -sI https://nsfwpixles.com/         # expect: 301 Location: https://nsfwpixels.com/
curl -sIL https://nsfwpixles.com/        # follows the redirect — expect 200 at the end

# Path preservation
curl -sI 'https://nsfwpixles.com/some/path?q=1'
# expect: 301 Location: https://nsfwpixels.com/some/path?q=1

# www variant
curl -sI https://www.nsfwpixles.com/
# expect: 301 Location: https://nsfwpixels.com/
```

## Single Redirect Rule (set in CF dashboard)

The redirect lives in the CF dashboard because the API token doesn't have
`Zone Rulesets:Edit` (would need to add that scope to script it via API).

To set / re-create:

1. Open https://dash.cloudflare.com → select the **`nsfwpixles.com`** zone
2. **Rules → Redirect Rules → Create rule**
3. Fields:
   - Rule name: `Typo redirect nsfwpixles -> nsfwpixels`
   - When incoming requests match: **All incoming requests**
   - Then…
     - Type: **Dynamic**
     - Expression: `concat("https://nsfwpixels.com", http.request.uri.path)`
     - Status code: **301**
     - Preserve query string: ✅ on
4. Deploy

## DNS records (managed via CF API)

Created by `tools/scripts/` flow on bootstrap (2026-05-26):

- `AAAA nsfwpixles.com -> 100::` (proxied)
- `AAAA www.nsfwpixles.com -> 100::` (proxied)
- `MX nsfwpixles.com -> route1/2/3.mx.cloudflare.net` (Email Routing)
- `TXT nsfwpixles.com -> "v=spf1 include:_spf.mx.cloudflare.net ~all"`

The `100::` AAAA is a Cloudflare convention — it's a non-routable IPv6 address
that resolves through CF's proxy. With `proxied=true`, all HTTPS traffic hits
the CF edge, where the Single Redirect Rule fires and returns a 301.

## Email — yes, this domain has working email

Even though there's no website here, `contact@nsfwpixles.com` and
`takedown@nsfwpixles.com` (and catch-all) all forward to `jessetamburino@hotmail.com`
via CF Email Routing. The typo-domain receives mail same as the canonical.

## To re-create this from scratch

If this setup ever gets wiped:

```bash
# 1. Confirm zone is active on CF
# 2. Add proxied AAAA records
set -a && . /home/jesse/projects/domains/.env && set +a
ZID=$(curl -sS "https://api.cloudflare.com/client/v4/zones?name=nsfwpixles.com" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"][0]["id"])')
for HOST in nsfwpixles.com www.nsfwpixles.com; do
  curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/${ZID}/dns_records" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"AAAA\",\"name\":\"${HOST}\",\"content\":\"100::\",\"ttl\":1,\"proxied\":true}"
done

# 3. Email routing
bash tools/scripts/setup-cf-email.sh nsfwpixles.com

# 4. Dashboard: create the Single Redirect Rule (see "Single Redirect Rule" above)
```

## Why a redirect and not a content clone

A redirect (this pattern) is the right call because:
- Visitor's browser bar ends up showing the *canonical* `nsfwpixels.com` URL — accurate
- Google indexes only the canonical URL — no duplicate-content SEO penalty
- One source of truth — content updates land in one place

The alternative (point both domains at the same Worker so they serve identical
content) would cause duplicate-content issues and confuse users about the real
URL of the site. Don't do that.
