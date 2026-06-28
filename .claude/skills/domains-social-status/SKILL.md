---
name: domains-social-status
description: Show fleet-wide social media status — which sites have accounts provisioned, which platforms are active, and recent post activity. Use for auditing social coverage, before onboarding a new site, or when troubleshooting why a site isn't posting. Also use when asked "what's our social media situation", "which sites post to X", or "show me social poster activity".
---

# Social Media Fleet Status

## Account provisioning — fleet-wide

```bash
cd /home/jesse/projects/domains
source .env
social-setup status --all
```
Shows per-site, per-platform: provisioned / pending / deferred.

## Account provisioning — single site

```bash
social-setup status <domain>
# or check credential files directly:
ls -la sites/<domain>/ops/social/
```

## Recent posts — single site

```bash
social-poster status <domain> --limit 20
```

## Recent posts — all sites at a glance

```bash
for site in $(ls /home/jesse/projects/domains/sites/); do
    echo "--- $site ---"
    social-poster status "$site" 2>/dev/null || echo "  (not configured)"
done
```

## Cron role health — is social-poster wired?

```bash
# Check which sites have the cron role installed
for site in $(ls /home/jesse/projects/domains/sites/); do
    ROLE="sites/$site/ops/roles/social-poster.md"
    CRON="sites/$site/ops/docker/crontab.docker"
    if [[ -f "$ROLE" ]]; then
        LINE=$(grep -o 'social-poster' "$CRON" 2>/dev/null && echo "(crontab OK)" || echo "(MISSING from crontab!)")
        echo "$site: INSTALLED $LINE"
    else
        echo "$site: not installed"
    fi
done
```

## Live post log (in running container)

```bash
cd sites/<domain>
docker compose exec cron tail -50 /app/logs/social-poster.log
# or from host (if log is bind-mounted):
tail -50 sites/<domain>/ops/logs/social-poster.log
```

## Persona status

```bash
# Check brand persona configs used by social-setup
python3 -c "
from social_setup.config import extract_brand
import os, sys
for d in os.listdir('sites'):
    try:
        b = extract_brand(d)
        print(f'{d}: {b.name} | {b.bio_short[:60]}')
    except Exception as e:
        print(f'{d}: no brand config ({e})')
"
```

## Stagger map — current social-poster offsets

See memory: `reference_cron_stagger_map.md` (social-poster section) for each site's
minute offset in the `MM 9,17 * * *` schedule. Add new sites there after installing
the cron role.

## Troubleshooting checklist

1. `ops/social/.<platform>-creds` file exists and is chmod 600?
2. `ops/roles/social-poster.md` exists (cron role installed)?
3. `social-poster` in `ops/docker/crontab.docker`?
4. Container rebuilt since crontab change? (`docker compose build cron && docker compose up -d cron`)
5. `social-poster post <domain> --dry-run` runs cleanly from inside the container?
6. `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_*` present in `.env.shared` (mounted at container start)?
