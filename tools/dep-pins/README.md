# dep-pins — one version of the deploy-critical dependencies, fleet-wide

`astro`, `@astrojs/cloudflare` and `wrangler` decide whether a site builds and
whether the build deploys. This tool makes their versions a **reviewed fleet
decision** instead of whatever each site's last lock refresh happened to
resolve.

## The failure mode this closes

Every site builds with `npm ci`, so a caret range does **not** float at build
time. It floats at *lock-refresh* time, independently per site — which is
quieter and worse. Measured on 2026-08-25 (B10), the fleet was simultaneously
running:

- **4** different `@astrojs/cloudflare` builds — 14.1.7, 14.2.0, 14.2.1, 14.2.3
- **6** different `astro` builds — 7.1.3 through 7.2.4
- **7** different `wrangler` builds

with nothing anywhere reporting it. An adapter change that breaks deploys would
have hit an arbitrary subset of sites on an arbitrary day and looked like a
per-site mystery rather than one dependency bump. This is the same lesson
`tools/fleet-images` already learned the hard way with Playwright: *do not let
something vary per site unless it has to.*

## Use

```bash
python3 tools/dep-pins/check_pins.py          # human report, exit 1 on drift
python3 tools/dep-pins/check_pins.py --json   # for a dashboard or cron
```

It checks two things, because they fail differently:

- **declared** — `package.json` must carry the exact version, no range. A range
  is how drift gets reintroduced.
- **resolved** — `package-lock.json` must actually resolve to it. A correct
  declaration with a stale lock still ships the old build.

## Bumping the fleet

1. Edit `pins.json`.
2. For each site: set the version in `site/package.json`, `npm install` to
   refresh the lock, **`npm run build` to prove it still builds**, commit, push.
3. `check_pins.py` should come back clean.

Never skip the build step. The 2026-08-25 rollout caught a real difference
between a static build (`dist/client/wrangler.json`) and an `output: 'server'`
build (`dist/server/wrangler.json`) that a naive check mistook for a failure.

## Enforcement

`precommit_check.sh` is wired into the shared hook (`tools/git-hooks/pre-commit`,
step 1d). It blocks a staged `package.json` that moves a pinned dep off the pin,
in both the monorepo and inside a site submodule/worker container. Override with
`DEP_PINS_ALLOW_RANGE=1` — and if you use it, add the site to `exempt` in
`pins.json` with the reason. An exception nobody wrote down is just drift again.

## Exempt sites

`pins.json → exempt` — sites that are not Astro at all (`0xroulette.com` is a
React/Vite SPA, `rc-9.com`, `trainingsharks.com`). They are skipped entirely
rather than reported every run.

## The IMAGES-binding hazard

`@astrojs/cloudflare` v14 injects an `images` binding into the generated
`wrangler.json` unless the site sets `imageService: 'passthrough'` (or
`'compile'`) in `astro.config`. An unprovisioned binding fails the deploy. All
38 adapter sites carry that setting as of 2026-08-25 — verify it survives any
future bump before rolling one out.
