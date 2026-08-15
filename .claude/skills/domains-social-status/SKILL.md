---
name: domains-social-status
description: Show fleet-wide social media status from the social registry — which sites have accounts, which are broken/suspended/never attempted, the persona roster, and recent post activity. Use for auditing social coverage, before onboarding a new site, when an account gets suspended or banned, or when troubleshooting why a site isn't posting. Also use when asked "what's our social media situation", "which sites post to X", "what social accounts are broken", or "show me social poster activity".
---

# Social Media Fleet Status

## Where the truth lives

The **social registry** — `tools/social-setup/registry/social.json`, served by
the Fleet Dashboard at http://127.0.0.1:4754/#social (Social tab) and its
`/api/social/*` API. It replaced the old `FLEET_SOCIAL_MAP.md` markdown table
on 2026-08-15.

Three record types: **accounts** (one row per site × platform × brand-or-persona,
each with a status), **personas** (the named-byline roster per site), and
**siteMeta** (each site's bucket: active / positioning_tbd / adult_excluded /
retired). Sites come from live `sites/*` discovery unioned with the registry, so
a newly onboarded domain appears without any registry edit.

Vaultwarden still holds the actual credentials — the registry only records
*whether* they exist (`credsInVault`), never the secrets themselves.

## Read it

```bash
cd /home/jesse/projects/domains
R="python3 tools/social-setup/scripts/social_registry.py"

$R worklist                      # broken accounts + never-attempted slots (start here)
$R summary                       # per-platform live/total rollup
$R list --site americastrikes.com
$R list --needs-attention        # everything in stuck/blocked/suspended/closed
$R list --platform instagram
$R list -q "spam"                # free-text over site/handle/persona/notes
$R personas --site saveusfarms.com
$R events --limit 30             # who changed what, when, and why
$R show sinderella.org pinterest # one slot in full
```

Add `--json` to any command for raw output.

## Write it

Same CLI — it upserts, so you don't have to check whether the row exists first.

```bash
# Account went live
$R set weapontester.com bluesky --status active --handle weapontester.bsky.social --creds

# Account got killed (this is how you tell the automation to redo it)
$R set newmomshop.com instagram --status suspended --note "closed for spam 2026-08-15"

# Persona account
$R set americastrikes.com pinterest --persona "Mariam Khalil" --status stuck \
     --note "silent submit failure — Pinterest soft-block, rotate VPN egress first"

# Site bucket
$R site-meta noveltyguns.com positioning_tbd --note "no brand brief yet"
```

Statuses: `active` `pending` `stuck` `blocked` `suspended` `closed`
`not_started` `excluded`. The registry derives an **action** from them —
`provision`, `unblock`, or `reprovision` — which is what `worklist` reports and
what the provisioning skill acts on.

Never hand-edit `social.json`; go through the CLI/API so the change is
validated and lands in the event log.

To actually (re-)create an account, use the `skills-domain-social-setup` skill —
it owns the signup scripts, captcha hand-off, and per-platform gotchas.

## Posting activity (separate system)

The registry tracks *account existence and health*. Actual posting is the
`social-poster` cron role:

```bash
social-poster status <domain> --limit 20
tail -50 sites/<domain>/ops/logs/social-poster.log
cd sites/<domain> && docker compose exec cron tail -50 /app/logs/social-poster.log
```

Cron role health — is social-poster wired?

```bash
for site in $(ls /home/jesse/projects/domains/sites/); do
    ROLE="sites/$site/ops/roles/social-poster.md"
    CRON="sites/$site/ops/docker/crontab.docker"
    if [[ -f "$ROLE" ]]; then
        grep -q 'social-poster' "$CRON" 2>/dev/null \
          && echo "$site: INSTALLED (crontab OK)" || echo "$site: INSTALLED (MISSING from crontab!)"
    fi
done
```

Stagger offsets for the `MM 9,17 * * *` schedule live in memory
`reference_cron_stagger_map.md` — add new sites there after installing the role.

## Troubleshooting checklist

1. Registry says the account is `active` for that site/platform? (`$R show <site> <platform>`)
2. Credentials actually in the vault? (`credsInVault` is a claim — verify with
   `social_lib.credentials.has_creds`)
3. `ops/roles/social-poster.md` exists (cron role installed)?
4. `social-poster` in `ops/docker/crontab.docker`?
5. Container rebuilt since the crontab change? (`docker compose build cron && docker compose up -d cron`)
6. `social-poster post <domain> --dry-run` runs cleanly inside the container?
7. `SLACK_BOT_TOKEN` / `SLACK_CHANNEL_*` present in `.env.shared`?
