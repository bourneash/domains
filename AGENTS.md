# AGENTS.md

Repo guide for AI agents (Codex, or any AGENTS.md-aware tool; Claude Code users see `CLAUDE.md`
files per-site and `~/.claude/CLAUDE.md` for house style).

## What this is

`domains` is the top-level organizer for a portfolio of independently-deployed sites under
`sites/<domain>/` (each a git submodule with its own repo), plus fleet-wide `tools/` shared
services (dashboard, AI usage tracking, social hub, data hub, ...) and cron-role automation that
runs each site mostly autonomously.

- `FLEET_STANDARD.md` — canonical site stack + deploy model (Astro + Cloudflare Workers).
- `DOMAINS_INDEX.md` — the site list.
- `tools/` — shared services used across every site.
- `sites/<domain>/` — one submodule per site; read that site's own `CLAUDE.md`/`AGENTS.md` before
  touching it, it has the site-specific brand voice, architecture, and gotchas.

## Skills

Fleet-wide operational skills (cron role installers, AI usage/cost audits, site launch, social
setup, SEO history, and dev references for the shared services) live in a separate repo:
**[bourneash/domains-skills](https://github.com/bourneash/domains-skills)** (private). It's wired
into this project as a Claude Code plugin marketplace via `.claude/settings.json`
(`extraKnownMarketplaces` / `enabledPlugins`) — Claude Code picks it up automatically.

For Codex or another AGENTS.md-aware agent: clone that repo (or add it as a submodule/checkout
alongside this one) and read `domains-skills/README.md` for the skill index and
`domains-skills/skills/<name>/SKILL.md` for each skill's instructions before doing fleet-wide work
(installing a cron role, auditing AI spend, launching a new site, etc.) — check there first rather
than re-deriving the process from scratch.

## Conventions worth knowing before editing

- Site repos are git submodules — commit inside the submodule first, then stage the pointer bump
  in this repo. Don't `git add -A` at the top level; other sessions may have unrelated work staged.
- `.env.shared` is gitignored and chmod 400 — unlock before edits, relock after.
- Worker containers that mount the repo read-write run as uid 1000 (`ops`), never root.
- See `domains-skills`' own skills for anything role/audit/launch-shaped before improvising.
