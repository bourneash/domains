# deployment-tester

Verifies that the **Cloudflare Workers Builds push-to-deploy** pipeline is
actually wired up for every site repo in the portfolio.

It drops/bumps a serial in a root-level `.deploy-probe` file in each
`sites/<domain>` submodule, pushes to `main` (which should trigger that repo's
Cloudflare Workers Build), and — with `--verify` — polls the CF API to confirm a
new worker version actually shipped. Repos that push but never get a new version
are the misconfigured ones.

## Quick start

```bash
cd /home/jesse/projects/domains

# See what's eligible (and which repos have in-flight work)
bash tools/deployment-tester/deploy-probe.sh --list

# Preview without changing anything
bash tools/deployment-tester/deploy-probe.sh --dry-run

# Trigger every eligible repo AND confirm each deploy landed
bash tools/deployment-tester/deploy-probe.sh --verify
```

## Why it's safe to run anytime

It **never touches in-flight work**. A repo is reported but left untouched if it
is not on `main`, has a dirty working tree, has unpushed/diverged local commits,
or loses a push race. Only the probe file is ever staged (never `git add -A`),
the probe lives outside `site/` so it can't affect the build, and the parent
superproject is never modified.

## Options

| Flag | Meaning |
|---|---|
| `--list` | List eligible repos + branches, then exit. |
| `--dry-run` | Show what would happen; make no changes. |
| `--verify` | After pushing, poll CF to confirm a new worker version shipped. |
| `--verify-timeout SECS` | Max wait for deploys in `--verify` (default 360). |
| `--delay SECS` | Pause between repos (default 5). |
| `--only "a.com b.com"` | Restrict to specific domains. |
| `--probe-file NAME` | Probe filename at repo root (default `.deploy-probe`). |
| `-h`, `--help` | Help. |

## Files

- `deploy-probe.sh` — the tool.
- `exclude.txt` — domains to skip (one per line; `#` comments ok). The tool only
  iterates real submodules, so non-repo redirect folders are excluded automatically.

## Reading the result table

| Deploy cell | Meaning |
|---|---|
| `✅ new <id>` | Pushed and Cloudflare shipped a new version — pipeline healthy. |
| `❌ no new version` | Pushed but no new version within the timeout — **Workers Builds likely not connected**. Investigate. |
| `⚠️ no worker found` | CF has no worker by that name — never created, or name mismatch in `site/wrangler.jsonc`. |
| `—` (skipped rows) | Not tested: in-flight work (not on main / dirty / diverged) or excluded. |

Worker name is read from each repo's `site/wrangler.jsonc` (`name`), falling back
to `<domain with dots→dashes>`. The GitHub link is derived from the submodule's
`origin` remote, so it's correct even when the repo name differs from the domain
(e.g. `reviewtattoo.com` → `bourneash/reviewtattoo`).

Driven by the `deployment-tester` Claude skill.

## Static check: CF IMAGES-binding landmine

`check-cf-image-binding.sh` is a separate, static (no network) check — it scans
every site on `@astrojs/cloudflare` v14+ (resolved from `package-lock.json`,
not local `node_modules`, since that's what CF actually installs) and flags
any with no `imageService` set on the adapter. v14 defaults `imageService` to
`'cloudflare-binding'`, which injects an unprovisioned `IMAGES` binding into
the generated wrangler config — `astro build` succeeds locally, but the real
CF Workers Build fails at `wrangler deploy`. First hit: saveusfarms.com,
2026-08-13 (dc44232a). Found the same unset config on 7 other v14 sites
(amputeenews, broadwayshowgirls, reviewtattoo, rodhat, weirdgirlstore,
wetpages, shoptopless) and preempted them the same day.

```bash
bash tools/deployment-tester/check-cf-image-binding.sh
```

Run this whenever a site is bumped onto `@astrojs/cloudflare` v14+, or
periodically across the fleet — it's cheap and has no side effects.
