---
name: domains-social-setup
description: Provision social media accounts for a domain site. Creates accounts on Bluesky, Reddit, Pinterest, X, TikTok, and LinkedIn via CloakBrowser + VPN proxy. Writes credential files to sites/<domain>/ops/social/. Use when onboarding a new site for social media, or adding a missing platform to an existing site. After provisioning, install the social-poster cron role via domains-cron-role-social-poster to automate posting.
---

# Social Media Account Provisioner

> **SUPERSEDED (2026-08-15).** Use `skills-domain-social-setup` instead — it is
> the current generation (Vaultwarden creds, per-platform full-automation
> scripts). Account status is tracked in the fleet social registry (Fleet
> Dashboard → Social, or `tools/social-setup/scripts/social_registry.py`), NOT
> in flat `ops/social/` cred files and NOT in any markdown table. This file is
> kept for its per-platform form/selector detail only.


> **Note:** A legacy `social-setup` skill also exists (Playwright MCP + manual gates). This skill
> (`domains-social-setup`) is the preferred approach — it uses the `social-setup` CLI with
> CloakBrowser + VPN, which is more reliable and doesn't require Claude to drive the browser
> directly. Use `domains-social-setup` for all new site onboarding.

Uses the `social-setup` Python package at `tools/social-setup/` + CloakBrowser
anti-detect browser for platform signups.

## Prerequisites

```bash
# 1. Ensure VPN proxy is running (for clean IPs per account)
cd /home/jesse/projects/domains/tools/vpn-proxy
docker compose ps  # should show vpn-us and vpn-eu as healthy
# If not running:
docker compose --env-file ../../.env up -d

# 2. Install Python packages
cd /home/jesse/projects/domains
pip install -e tools/social-lib/ -e tools/social-setup/ -q

# 3. Load shared env
source .env
```

## Provision a site

```bash
# Provision all platforms in the recommended order
social-setup provision <domain>
# e.g.: social-setup provision americastrikes.com
```

Order: **Bluesky → Reddit → Pinterest → X → TikTok → LinkedIn**
(Easiest/no-phone-verify first; X + TikTok have SMS gates.)

## CloakBrowser provisioner (preferred)

CloakBrowser (anti-detect Chromium) is the preferred runner for all signups:

```bash
# Provision a single platform
python3 -m social_setup.cloak_provision bluesky <domain>
python3 -m social_setup.cloak_provision reddit <domain>
python3 -m social_setup.cloak_provision pinterest <domain>
python3 -m social_setup.cloak_provision x <domain>
python3 -m social_setup.cloak_provision tiktok <domain>
python3 -m social_setup.cloak_provision linkedin <domain>
```

Screenshots land in `/home/jesse/projects/domains/.cloak-screenshots/` — read them
with the Read tool to see what's on screen at any human gate.

## SMS gate (X and TikTok)

When X or TikTok requires phone verification, CloakBrowser pauses and prints:
```
[SMS GATE] Code sent to 6107378479
Write it to /tmp/cloak-gates/<gate-name>.continue to continue.
```
Check Jesse's phone, then in another terminal:
```bash
echo "123456" > /tmp/cloak-gates/<gate-name>.continue
```

## CAPTCHA gate

Take a screenshot and show Jesse — he can click directly in the CloakBrowser window
(visible on his screen). Don't attempt to solve visual CAPTCHAs autonomously.

## Check status

```bash
social-setup status <domain>
social-setup status --all   # fleet-wide
```

## Credential files

Written to `sites/<domain>/ops/social/.<platform>-creds`, chmod 600.
Format: `KEY=VALUE`, one per line.
These are gitignored (they contain API keys and passwords).

## Include Meta (when available)

```bash
social-setup provision <domain> --include-meta
# Requires SMSPOOL_API_KEY in .env for Facebook/Instagram phone verify
```
Meta platforms (Facebook Page, Instagram Business) are deferred by default due to
Business Verification requirements — only provision when Jesse has cleared that.

## After provisioning

Install the social-poster cron role so articles post automatically:
```bash
# Use the domains-cron-role-social-poster skill
```

Or test posting immediately:
```bash
social-poster post <domain> --dry-run   # preview
social-poster post <domain>             # live post
```

## Rules

- `contact@<domain>` is the default outward-facing email; `social@<domain>` is for platform signups only
- Never batch CF email routing verification sends — serialize per site
- Never invent brand positioning — read `sites/<domain>/CLAUDE.md` for voice/bio
- Each platform is independent — one failure doesn't block others
- Check for existing creds before starting a platform:
  ```bash
  ls sites/<domain>/ops/social/  # or:
  python3 -c "from social_setup.credentials import has_creds; print(has_creds('sites/<domain>', 'bluesky'))"
  ```
