---
name: domains-social-hub
description: Operate the fleet social media platform (tools/social-hub) — the content queue, scheduler, AI drafting, approval/editing, publishing and reply inbox across sites. Use when asked to schedule or write social posts, review/approve/reject queued posts, reply to mentions, onboard a site to social automation, check why a site isn't posting, change posting cadence or voice, or run/debug the social tick. Triggers on "social queue", "schedule a post", "approve posts", "social hub", "post to Bluesky", "reply to mentions", "social cadence", "onboard <site> to social".
---

# Social Hub — fleet social media operations

Full docs: `tools/social-hub/README.md`. This skill is the operating cheat sheet.

## What it is

One control plane over every managed site's social presence: ingest site
content → AI-draft copy per platform → approval queue → scheduler → publish →
mirror to the site's own `ops/social/post-log.jsonl`; plus a mentions inbox
with AI-drafted replies. CLI, HTTP API, and a web UI on
http://127.0.0.1:4772 (`social-hub serve`).

It does NOT own accounts or secrets: the social registry
(`tools/social-setup/registry/social.json`) is the account inventory and
Vaultwarden holds the credentials. Marking an account `suspended` in the
registry disables its channel here on the next sync — one kill switch.

## Daily driving

```bash
social-hub status                       # queue, next send, inbox depth per site
social-hub queue --site <domain>        # what's waiting
social-hub show <id>                    # one post in full
social-hub approve <id> [<id>...]       # approve + schedule
social-hub reject <id> --reason "..."   # rejecting frees the article to be redrafted
social-hub edit <id> --body "..."       # rewrite copy (any pre-publish state)
social-hub compose <site> <platform>    # one-off; omit --body to have AI draft it
social-hub publish --post <id>          # send now, bypassing the schedule
social-hub inbox list|poll|draft|ignore # mentions and replies
social-hub tick [--site <domain>]       # the whole pipeline once (what cron runs)
social-hub doctor                       # env check: channels, creds, AI backend
```

## Onboarding a site

1. Confirm the site has a live account: `social-hub channels list --site <domain>`
   (run `social-hub channels sync` first). No account → provision it with
   `skills-domain-social-setup`, not here.
2. Write `sites/<domain>/ops/social/hub.yaml`. Copy
   `sites/0daynews.com/ops/social/hub.yaml` (manual review) or
   `sites/americastrikes.com/ops/social/hub.yaml` (fully autonomous) and edit
   `voice`, `ai.guardrails`, `platforms`, and `cadence`. **The presence of this
   file is the opt-in** — there is no fleet-wide switch, on purpose.
3. Start on `platforms: [console]` — a local JSONL outbox — and read what the
   model writes before pointing it at a real account.
4. `social-hub tick --site <domain> --no-publish`, then review the queue.
5. Flip `approval: auto` per site or per platform only once the copy reads right.

## Rules that matter

- **Voice and guardrails are per site, in the site's own config.** Never put
  brand positioning in the tool. `ai.guardrails` is where you say the thing the
  model must never do (invent a CVE ID, state a casualty figure).
- **Community routing is config, never a model choice** — subreddits, board ids.
- **Replies default to manual** even on auto sites, and the model is allowed to
  decline (`SKIP`). There is no canned fallback reply; silence beats a bot reply.
- **The tick is idempotent** and safe to run overlapping — publishing claims
  rows, ingestion is keyed, drafting checks for an existing draft.
- **AI spend is tracked**: the `cli` backend goes through `claude-tracked.sh`
  with `CRON_ROLE=social-hub`, so it lands in the AI Usage tab per site.
  `SOCIAL_HUB_AI_BACKEND=fake` disables model calls entirely (templated copy).

## When something isn't posting

1. `social-hub doctor` — missing channel, disabled channel, or missing creds.
2. `social-hub status --site <domain>` — is anything scheduled, or is the queue
   full of unapproved drafts?
3. `social-hub channels verify --site <domain>` — live auth check.
4. `social-hub queue --status failed` — read `error`; retries are 5/20/80 min,
   then parked as `failed` with a Slack alert.
5. Quiet hours / daily cap can legitimately push everything to tomorrow — check
   `cadence` in the site's hub.yaml.

## Platform reality

bluesky (post/reply/inbox, every fleet account vaulted) · mastodon (full,
token only) · x (post/reply; mentions need a paid tier) · reddit (complete but
**parked fleet-wide** — OAuth app creation is blocked) · pinterest (needs a
business account + approved app) · console (local outbox, always available).
