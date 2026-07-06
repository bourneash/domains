# post-notify

Shared "new post" Slack announcer. One tool, one Block Kit card format, config-driven per site — replaces the old copy-pasted `share-new-articles-slack.sh` per site.

Posts via the shared Domain Ops bot (`SLACK_BOT_TOKEN` in the fleet `.env`), targeting each site's own channel (`SLACK_CHANNEL_<SITE>` env var). Card: brand/context line, title, description, cover image, "Read on \<site\>" button. Dedup + first-run seeding via a per-site `ops/social/slack-shared.json` state file (never floods a channel with the back catalogue on first hookup).

## Hooking in a new site

1. Add `ops/social/post-notify.json` in the site repo (see existing sites for examples — americastrikes.com, saveusfarms.com, 0daynews.com, aliencouncil.com). Fields:
   - `base_url`, `content_dir` (relative to site repo root), `url_template` (`{base}`/`{slug}` placeholders)
   - `channel_env` / `channel_default` — matches an existing `SLACK_CHANNEL_*` var in the fleet `.env`
   - `title_field`, `description_field`, `image_fields`, `date_field`, `unlisted_field` — map to your content collection's frontmatter (`unlisted_field: null` if the collection has no draft flag)
   - `brand_context` — the fixed emoji + site name prefix
   - `context_fields` — list of `{field, transform}`; `transform` is `upper`, `title_dash`, `emoji_map` (needs a `map` dict keyed by frontmatter value), or `raw`
   - `recent_days` — announce window from publish/observed date
2. Add a thin wrapper at `ops/scripts/share-new-articles-slack.sh` (copy an existing site's — it's ~10 lines: source `.env.shared`, then `python3 <path-to-this-tool>/share_new_posts.py --config ops/social/post-notify.json`).
3. Call that wrapper from the end of your publish flow (post-write / deploy script), non-fatal (`|| true`).

First run seeds silently — nothing posts until the second run picks up something newer than the seed.

## Sites wired in (2026-07)

- americastrikes.com, saveusfarms.com — migrated from their original per-site scripts (same behavior, same state file, now delegating to the shared tool)
- 0daynews.com, aliencouncil.com — newly wired, no prior new-post Slack alerts existed
- sinderella.org — **not migrated**. Its content collections (horoscopes, tarot, tea, rituals) don't fit the articles/kind/topic shape this tool assumes, and it already gets team visibility via a different mechanism (per-role plain-text + threaded digest in `ops/scripts/run-role.sh` / `slack_thread_digest.py`). Revisit if sinderella grows an article-like collection.
