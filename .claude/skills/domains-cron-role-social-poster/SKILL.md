---
name: domains-cron-role-social-poster
description: Install (or maintain) the Social Poster cron role on any portfolio site under /home/jesse/projects/domains/sites/. Posts the site's latest articles to all active social platforms (X, Bluesky, Reddit, Pinterest, TikTok, LinkedIn) twice daily at 9am + 5pm UTC. Bash-driven — zero Claude turns per run. Use after social accounts have been provisioned for the site (check with `social-poster status <domain>` or inspect `sites/<domain>/ops/social/` for credential files). Use when the user asks to "add social poster", "schedule social posts", "install social-poster cron", or "automate social media posting for <site>".
---

# Install the Social Poster cron role

Archetype library: `tools/cron-roles/archetypes/social-poster/`
Runner script: `tools/social-poster/cron/run.sh`
Mechanical procedure: **follow `tools/cron-roles/WIRING.md` exactly**, with
`<name>` = `social-poster`. Awareness: `tools/cron-roles/handoff-protocol.md`.

## Pre-flight: confirm social accounts are provisioned

```bash
ls sites/<domain>/ops/social/  # should have .<platform>-creds files
# or: social-poster status <domain>
```

If no credential files exist, run the `domains-social-setup` skill first.

## Step-by-step

1. Run WIRING.md Steps 1–13 against the target site, reading this archetype's
   `meta.yml` for schedule/model/worker_deps/placeholders/gitignore.
   Social-poster-specific placeholders:
   - `SOCIAL_POSTER_MINUTE`: pick an unused minute offset (0–29) from the fleet
     stagger map (`reference_cron_stagger_map.md`, social-poster section). Do NOT
     use 0. Add the new site+offset to the stagger map after installing.
   - `DOMAIN`: bare domain, e.g. `americastrikes.com`
   - `SITE_SHORT`: slug without TLD, hyphens stripped, e.g. `americastrikes`
   - `SLACK_CHANNEL_VAR` / `SLACK_CHANNEL_DEFAULT`: from `ops/scripts/run-role.sh`

2. This is a **bash-driven role** (`meta.model: none`). WIRING.md Step 6 MUST wire
   the explicit bash branch in `run-role.sh` — do NOT dispatch via generic `claude -p`:

   ```bash
   elif [[ "$ROLE" == "social-poster" ]]; then
     set +e
     bash "$REPO_ROOT/ops/scripts/run-social-poster.sh" "$LOG" 2>&1 | tee -a "$LOG"
     STATUS=$?
     set -e
   ```

   The script self-posts Slack on failure, so `meta.self_notifies: true` — do NOT
   add `social-poster` to `run-role.sh`'s success-notify allowlist (double-post guard).

3. `meta.worker_deps` is empty — no Dockerfile.worker changes (Step 8 skipped).
   The Step 11 rebuild is still mandatory: new crontab line must bake into the image.

4. The archetype script `run-social-poster.sh.tmpl` (from `archetypes/social-poster/scripts/`)
   is stamped into `ops/scripts/run-social-poster.sh` with placeholders substituted
   and `chmod +x` applied (WIRING.md Step 5).

5. Copy the generic runner into ops as well (for containerised use):
   ```bash
   mkdir -p sites/<domain>/ops/cron/social-poster/
   cp tools/social-poster/cron/run.sh sites/<domain>/ops/cron/social-poster/run.sh
   chmod +x sites/<domain>/ops/cron/social-poster/run.sh
   ```
   Mount (or COPY) this into the container at `/app/cron/social-poster/run.sh` if the
   site's ops container uses `DOMAIN` + `LOG_DIR` env-driven runner style.

6. The `social-poster` CLI must be available in the ops container. Add to
   `sites/<domain>/ops/requirements.txt`:
   ```
   social-poster @ file:///app/tools/social-poster
   social-lib @ file:///app/tools/social-lib
   ```
   (Paths assume tools/ is bind-mounted to /app/tools/ in docker-compose.yml.)

7. After Step 11 rebuild + verify, confirm the CLI works in-container:
   ```bash
   docker compose exec ops social-poster post <domain> --dry-run
   ```
   Expected: lists articles that would be posted without actually posting.

8. Update the fleet stagger map in memory (`reference_cron_stagger_map.md`) with the
   new site's social-poster minute offset.

## Maintain mode

If `ops/roles/social-poster.md` already exists, WIRING.md runs Steps 4, 10, 11 only
(refresh role body + sibling awareness, re-verify). Never destroy operator edits.
