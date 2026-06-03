# Domain Fleet — Site Standard

The canonical stack + deploy model for sites under `projects/domains/sites/`.
Reference implementations (all migrated & verified 2026-05-30):
**totaljerks**, **aliencouncil**, **reviewtattoo** (static) and **weapontester** (React/Three.js).

## Stack

| Layer | Standard | Notes |
|---|---|---|
| Framework | **Astro 6** (`^6.4.x`) | Astro 5 is EOL for new work. |
| CF adapter | **`@astrojs/cloudflare` `^13`** | Server build → emits `dist/server/wrangler.json` for the deploy command. Omit it on custom-worker sites (see weapontester). |
| CSS | **Tailwind v4** via **`@tailwindcss/vite`** | `@astrojs/tailwind` is dead on Astro 6. |
| Host | **Cloudflare Workers Static Assets** | NOT Pages. NOT the legacy `wrangler pages deploy`. |
| CI deploy | **Cloudflare Workers Builds** (Git integration) | Build `npm run build`, deploy `npx wrangler deploy --config dist/server/wrangler.json`. Push to `main` → auto-build+deploy (same contract Pages gave). |
| Repo | `bourneash/<name>` private, SSH alias `git@github-bourneash:` | |

## Deploy model — server build, `--config dist/server/wrangler.json`

The fleet builds **server** (not static), matching wetpages/shoptopless. The
`@astrojs/cloudflare` v13 adapter emits the real config to **`dist/server/wrangler.json`**
at build time; the top-level `site/wrangler.jsonc` is **minimal** (no `main`, no `assets`):

```jsonc
{
  "name": "<name>-com",
  "compatibility_date": "2026-05-26",
  "observability": { "enabled": true },
  "compatibility_flags": ["global_fetch_strictly_public", "nodejs_compat"]
}
```

- **Worker name:** `<domain-with-dashes>` e.g. `aliencouncil-com`, `totaljerks-com`.
- **Deploy command** (package.json + CF Workers Builds dashboard):
  **`npx wrangler deploy --config dist/server/wrangler.json`**. The bare
  `npx wrangler deploy` fails with "Missing entry-point" — CF defaults are wrong.
- **Local preview/smoke:** `wrangler dev --config dist/server/wrangler.json`
  (a server build is NOT served by `wrangler pages dev`).
- **Forcing the server build:** a purely-static site emits `dist/client/` only,
  which has no `dist/server/wrangler.json` and breaks the deploy command (this
  was the original totaljerks failure). Ensure at least one **on-demand route**
  so the adapter produces a server build — the fleet way is `src/pages/rss.xml.ts`
  with `export const prerender = false` (wetpages) or `/go/[slug].ts` SSR
  (shoptopless). All other pages stay prerendered (static perf preserved).
- `_redirects` (`/go/*` cloaking) and `_headers` are served natively in server
  mode too — no rewrite needed.
- gitignore `site/.wrangler/`.

**Custom-worker sites** (weapontester): keep `worker/index.js` + a `wrangler.jsonc`
with `main` + `assets: ./dist`; deploy is plain `npx wrangler deploy`. Do not add
the adapter. This is a deliberate exception for interactive (React/Three.js) apps.

## Tailwind v4 rules

- Global CSS: `@import "tailwindcss";` then `@config "../../tailwind.config.mjs";`
  (keeps the existing JS theme). If no global CSS existed (integration
  auto-injected it), create one and import it in the base layout.
- Custom classes used in `@apply` must be promoted to `@utility name { ... }`.
- Scoped Astro `<style>` blocks using `@apply`/`theme()` need
  `@reference "../styles/global.css";` at the top.

## Content collections (Astro 6)

Legacy collections are **removed**. Each site with `src/content/`:
- Move `src/content/config.ts` → `src/content.config.ts`.
- Give each collection a loader: `glob({ pattern: '**/*.md', base: './src/content/<name>' })`
  (`**/*.json` for data collections).
- API: `entry.slug` → `entry.id`; `await entry.render()` → `await render(entry)`
  (import `render` from `astro:content`).
- Lowercase-slug markdown filenames ⇒ `entry.id` == old `.slug` ⇒ URLs unchanged.
- Do **not** convert locally-built `{slug:…}` objects or `entry.data.slug` fields.

## Deployment — push to main, never local wrangler

**Deploy = `git push origin main` → Cloudflare Workers Builds** (Git integration).
The build (`npm run build`) and deploy (`npx wrangler deploy --config dist/server/wrangler.json`) commands run in
**CF's build container, not on anyone's machine**. Running `wrangler login` /
`wrangler deploy` / `wrangler pages deploy` locally is an **anti-pattern** — don't.
The `deploy` npm script, if present, is a documented break-glass fallback only.

Content-automation skills that `git push origin main` deploy automatically via the
same Workers Build — the push→deploy contract is what the skills rely on.

## Verification gate (before merge)

1. `npm run build` clean (this is the same command Workers Builds runs).
2. `npm audit --audit-level=high` → 0 (run `npm audit fix` first).
3. Site tests (vitest / playwright) pass.
4. Optional local visual check: `astro preview` / static file server.
5. **Post-deploy:** smoke the **live domain** with `curl` (the fleet pattern —
   e.g. `ops/scripts/smoke-live.sh`): home 200, `/go/*` 302 with the right
   affiliate tag, 404 returns 404.

## Publishing (Pages → Workers cutover, one-time, CF dashboard)

These are CF-dashboard actions (the only manual part). No local wrangler.
1. Create the Worker + connect **Workers Builds** to the repo: root dir `site`,
   build `npm run build`, deploy `npx wrangler deploy --config dist/server/wrangler.json`, Node 22, production branch `main`.
2. Move the custom domain from the Pages project → the Worker.
3. Merge the PR → the push to `main` triggers the first Workers Build (= deploy).
4. Delete/disable the old Pages project.
5. Smoke the live domain with `curl`.

## Fleet status (2026-05-30)

- **On standard:** ~33 sites already Astro 6 + adapter 13 (no Tailwind).
- **Migrated, PR open, awaiting cutover:** aliencouncil (#2), reviewtattoo (#6),
  weapontester (#1, already on Workers); totaljerks needs only its dashboard
  deploy command set to `npx wrangler deploy --config dist/server/wrangler.json`.
- **Owner-handled:** sinderella (heavy Docker automation).
- **Remaining laggards (Astro 5 + Tailwind 3):** americastrikes, xxxtea,
  ultrarough, saveusfarms. **Junk to resolve:** nsfwpixles.com (no package.json),
  rc-9.com (empty), the 3 old Pages sites.
