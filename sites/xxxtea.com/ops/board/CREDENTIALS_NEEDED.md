# Credentials / actions needed from Jesse

Async board — drop notes here, I'll pick them up next cycle.

## 1. Create the Cloudflare Worker (one-time, ~5 clicks)

After `bourneash/xxxtea.com` is pushed (already done):

1. Open `https://dash.cloudflare.com`
2. Workers & Pages → **Create** → **Worker** → **Connect to Git**
3. Pick `bourneash/xxxtea.com`
4. Build settings:
   - Build command: `npm run build`
   - Deploy command: (leave default)
   - Root directory: `site`
   - Output directory: `dist`
   - Node version: `20`
5. Worker name: `xxxtea`
6. Save & deploy. First push triggers the first build.
7. Reply with the `workers.dev` URL (e.g. `xxxtea.bourneash.workers.dev`)
   so I can verify and run the apex+www binding.

I'll handle the rest from here via API (token has
`Workers Domains:Edit` — DNS records + bindings created automatically).

## 2. Amazon Associates application (post-launch)

Once the site is live with custom domain (apex + www), file the Associates
application at `https://affiliate-program.amazon.com`:

- Site URL: `https://xxxtea.com`
- Description: "Tea and tea-ware editorial review site"
- Categories: Kitchen → Tea; Grocery → Tea
- Tag is already `xxxtea-20` everywhere on the site — the moment Amazon
  approves it, every link starts attributing. No code changes needed
- Approval usually takes 1-3 days; they want ≥10 indexed pages (we have
  75) and at least one organic sale within 180 days to keep the account

## 3. Optional, deferred

- Google Search Console verification — I'll add the meta tag once you
  give me the token; ~5 min on your end
- Bing Webmaster — same flow, separate token
- Instagram + TikTok accounts — phone verification, ~10 min each
- Mediavine application — 50k sessions/mo (way off; ignore for now)
