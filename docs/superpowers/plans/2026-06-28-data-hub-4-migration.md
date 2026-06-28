# Data Hub — Plan 4: Per-Site Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. These sites are git SUBMODULES — commit inside the submodule, then bump the parent pointer. Each site is validated LIVE (run a real collect/pull cycle, check the run log, confirm the hub VPN path, parity-check output) before moving to the next.

**Goal:** Migrate each site's external data collection from its own scraper to pulling from the central hub — so ALL external fetching happens once, behind the hub's VPN — while keeping each site's `news-feed.json` (and downstream roles/build) byte-compatible.

**Architecture:** For each news site, a new `ops/scripts/pull-feeds.py` is derived from that site's existing `scrape-feeds.py` by replacing ONLY the feed-fetch loop with a single pull from the hub's `/subscriptions/<host>/items`; every downstream behavior (beat classification, 48h cutoff, hot-cap, cold archive, seen-url dedup, priority floor, atomic write) is reused verbatim, guaranteeing identical output shape. The site's cron container joins the `vpn-proxy_default` network to reach `datahub-api:4760`. The old scraper stays in place for one cycle as rollback, gated by a parity check, then is retired. sinderella's brief-builder swaps its raw API fetches for hub `/datasets/*` calls; saveusfarms' War Room (NASS/EIA) is DEFERRED until keys exist (the hub datasets are empty without them).

**Tech Stack:** Python (per-site scrapers), Docker Compose, the hub API from Plans 1-3.

## Global Constraints

- Sites are SUBMODULES under `sites/<host>/`. Work inside the submodule; commit there (per-file `git add`, never `-A`); then in the superrepo bump the pointer (`git add sites/<host>` + commit). Follow the fleet commit convention.
- Migration order (validate each LIVE before the next): **americastrikes.com → aliencouncil.com → broadwayshowgirls.com → saveusfarms.com (RSS) → sinderella.org (datasets)**. saveusfarms War Room datasets are DEFERRED (no NASS/EIA keys).
- The hub API is reachable from a site's cron container ONLY after the container joins the external `vpn-proxy_default` docker network (datahub-api binds host loopback, so `host.docker.internal` does NOT reach it — same finding as Plan 3). Call `http://datahub-api:4760`, env `DATAHUB_API` (default that value).
- **Byte-compatibility is the gate.** `pull-feeds.py` MUST produce `news-feed.json` with the EXACT same record schema as the site's `scrape-feeds.py`: `{title, url, published_iso, summary, source, beat}`, JSON array, `indent=2, ensure_ascii=False`, newline-terminated. Preserve that site's hot-cap, seen-url format, cold-archive on/off, and priority logic by REUSING its own code — derive `pull-feeds.py` from the site's `scrape-feeds.py`, don't rewrite from scratch.
- **Fail-safe:** if the hub is unreachable, `pull-feeds.py` must keep the existing `news-feed.json` untouched (no clobber with empty), log the failure, and exit 0 (so the cron run is not a hard failure and the site's build never breaks). It must NEVER fall back to scraping external feeds directly (that would bypass the VPN).
- The old `scrape-feeds.py` is NOT deleted during a site's migration task — it's left in place for one cycle as rollback; a follow-up cleanup (out of this plan's per-site task) removes it after the site is confirmed healthy.
- Each site's external scraping previously ran NOT behind a VPN; after migration the site makes only a loopback-equivalent call to the hub, and the hub does the external fetching behind PIA. Validation must confirm the puller hits ONLY the hub, not external feeds.
- No automated test suite in the sites — validation is live: run the cycle, read the run log, inspect `news-feed.json`, check the hub `/egress` for the VPN path, confirm parity.

---

## The shared transformation (applied per-site, derived from each site's own scraper)

`pull-feeds.py` = a copy of the site's `scrape-feeds.py` with these surgical changes:

1. Add a hub-pull helper near the top:
```python
import os
HUB_API = os.environ.get("DATAHUB_API", "http://datahub-api:4760")
SITE_HOST = "<host>"   # e.g. "americastrikes.com" — the subscription key in the hub

def fetch_hub_items() -> list[dict]:
    """Pull this site's subscribed items from the hub. Returns [] on any failure
    (caller then keeps the existing cache untouched — never scrape externally)."""
    import urllib.request, json as _json
    url = f"{HUB_API}/subscriptions/{SITE_HOST}/items"
    req = urllib.request.Request(url, headers={"User-Agent": "datahub-puller/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = _json.loads(r.read().decode("utf-8"))
    return data.get("items", [])
```
(Use stdlib `urllib` to avoid adding a `requests`/`httpx` dependency to the cron image; the call is to the local hub so no proxy is involved.)

2. Replace the `for feed_cfg in FEEDS:` fetch loop (the part that builds `new_stories`) with:
```python
    try:
        hub_items = fetch_hub_items()
    except Exception as exc:
        print(f"[puller] hub unreachable — keeping existing cache untouched: {exc}", file=sys.stderr)
        return   # leave news-feed.json + seen-urls as-is; exit cleanly
    if not hub_items:
        print("[puller] hub returned 0 items — keeping existing cache", file=sys.stderr)
        return

    new_stories = []
    for item in hub_items:
        url = (item.get("url") or "").strip()
        if not url or url in seen_url_set:
            continue
        title = (item.get("title") or "").strip()
        if not title:
            continue
        summary = (item.get("summary") or "")[:500]
        published = item.get("published_iso") or datetime.now(timezone.utc).isoformat()
        beat = classify_beat(title, summary, DEFAULT_BEAT)   # site's own classify_beat
        new_stories.append({
            "title": title, "url": url, "published_iso": published,
            "summary": summary, "source": item.get("source") or "", "beat": beat,
        })
        seen_url_list.append(url)
        seen_url_set.add(url)
```
3. Keep EVERYTHING else (the seen-url load, the 48h cutoff, the merge/sort, the hot-cap, the cold-archive call if the site has one, the priority-floor block if the site has one, the atomic writes of news-feed.json and seen-urls) EXACTLY as in the site's scraper. `DEFAULT_BEAT` = the site's most generic beat (americastrikes: `"domestic"`; aliencouncil: `"sighting"`→ use its scraper's most generic default; broadwayshowgirls: `"industry"`; saveusfarms: its generic default). Read the site's `scraper.json`/`classify_beat` default to pick it.

4. Point the cron at the puller: edit the site's `ops/scripts/run-scraper.sh` (or `run-worker.sh scrape` path for bsg) to invoke `pull-feeds.py` instead of `scrape-feeds.py`. Leave `scrape-feeds.py` on disk.

5. The cron container must reach the hub: add the external network join to the site's `docker-compose.yml` (the cron/worker service):
```yaml
    networks:
      - default
      - vpn_proxy
# ...at file level:
networks:
  vpn_proxy:
    external: true
    name: vpn-proxy_default
```
and `DATAHUB_API: http://datahub-api:4760` in the cron service environment.

---

### Task 1: Migrate americastrikes.com (the template) + live validation

**Files (in `sites/americastrikes.com/`):**
- Create: `ops/scripts/pull-feeds.py` (derived from `ops/scripts/scrape-feeds.py`)
- Modify: `ops/scripts/run-scraper.sh` (invoke pull-feeds.py)
- Modify: `docker-compose.yml` (cron service joins vpn-proxy_default + DATAHUB_API env)

**Interfaces:** Produces a `news-feed.json` identical in schema to today's, sourced from the hub.

- [ ] **Step 1: Derive `pull-feeds.py`** from `sites/americastrikes.com/ops/scripts/scrape-feeds.py` per the shared transformation above. americastrikes specifics to PRESERVE verbatim: 200-cap, text `seen-urls.txt` (5000), cold archive to `ops/cache/cold/YYYY-MM.jsonl`, the PRIORITY_SOURCES/PRIORITY_FLOOR block, `DEFAULT_BEAT = "domestic"`. `SITE_HOST = "americastrikes.com"`.

- [ ] **Step 2: Point the cron at the puller.** In `ops/scripts/run-scraper.sh`, change the `python3 ops/scripts/scrape-feeds.py` invocation to `python3 ops/scripts/pull-feeds.py`. (Leave scrape-feeds.py in place.)

- [ ] **Step 3: Wire hub network access.** In `sites/americastrikes.com/docker-compose.yml`, add the `vpn-proxy_default` external network join + `DATAHUB_API: http://datahub-api:4760` env to the cron service (per the shared transformation §5). Keep all existing service config.

- [ ] **Step 4: Rebuild the cron container and run ONE cycle**

```bash
cd /home/jesse/projects/domains/sites/americastrikes.com
docker compose --env-file /home/jesse/projects/domains/.env up -d --build cron
sleep 5
# back up the current cache to diff against
cp ops/cache/news-feed.json /tmp/as-before.json 2>/dev/null || echo "(no prior cache)"
# run the puller inside the cron container exactly as cron would
docker compose --env-file /home/jesse/projects/domains/.env exec -T cron bash ops/scripts/run-scraper.sh
```

- [ ] **Step 5: VALIDATE (the gate — do all of these)**

```bash
cd /home/jesse/projects/domains/sites/americastrikes.com
# (a) news-feed.json written, correct schema, non-empty
python3 -c "import json; d=json.load(open('ops/cache/news-feed.json')); print('stories:', len(d)); s=d[0]; assert set(s)>={'title','url','published_iso','summary','source','beat'}, s.keys(); print('schema OK; sample beat=',s['beat'],'source=',s['source'])"
# (b) it pulled from the HUB, not external feeds — check the run log for the puller line + no feedparser fetches
docker compose --env-file /home/jesse/projects/domains/.env exec -T cron sh -c 'tail -40 ops/logs/*scraper* 2>/dev/null || true'
# (c) the cron container actually reaches the hub by name
docker compose --env-file /home/jesse/projects/domains/.env exec -T cron sh -c 'python3 -c "import urllib.request,json; print(len(json.load(urllib.request.urlopen(\"http://datahub-api:4760/subscriptions/americastrikes.com/items\",timeout=10))[\"items\"]), \"items reachable\")"'
# (d) the VPN path: the hub collected these behind PIA — confirm via the egress ledger (real exit IP, not home)
curl -s "http://127.0.0.1:4760/egress?limit=20" | python3 -c "import sys,json; ev=json.load(sys.stdin)['events']; vpn=[e for e in ev if e['policy']=='vpn' and e['status']=='ok']; print('vpn-ok egress sample:', vpn[0]['exit_ip'] if vpn else 'NONE', '(home IPs must NOT appear)')"
# (e) fail-safe: stop the hub, run again, confirm the cache is UNTOUCHED (not clobbered) and exit is clean
docker stop datahub-api
docker compose --env-file /home/jesse/projects/domains/.env exec -T cron bash ops/scripts/run-scraper.sh; echo "exit=$?"
python3 -c "import json; print('stories after hub-down:', len(json.load(open('ops/cache/news-feed.json'))))"  # unchanged, non-zero
docker start datahub-api
```
Expected: (a) non-empty, schema OK; (b) log shows the puller ran (no external feed fetching); (c) the container reaches the hub by name; (d) the hub's egress shows `vpn` `ok` rows with a real PIA exit IP (NOT 24.55.143.75/158.173.25.169); (e) with the hub down the run exits 0 and leaves news-feed.json unchanged (fail-safe holds). If any fails, fix before committing.

- [ ] **Step 6: Commit (submodule + pointer)**

```bash
cd /home/jesse/projects/domains/sites/americastrikes.com
git add ops/scripts/pull-feeds.py ops/scripts/run-scraper.sh docker-compose.yml
git commit -m "feat(ops): pull news-feed from central data-hub instead of direct scraping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
cd /home/jesse/projects/domains
git add sites/americastrikes.com
git commit -m "chore: bump americastrikes pointer — migrate scraping to data-hub puller

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Migrate aliencouncil.com + live validation

Same as Task 1, derived from `sites/aliencouncil.com/ops/scripts/scrape-feeds.py`. **Deltas:** 200-cap, text seen-urls, **NO cold archive** (don't add one), no priority floor, `beat_patterns` config, per-feed `required_pattern` is irrelevant now (the hub already applied it — aliencouncil's VICE source carries `required_pattern` in the hub registry). `SITE_HOST = "aliencouncil.com"`; `DEFAULT_BEAT` = aliencouncil's generic default (read its scraper). Cron: `*/15` `run-scraper.sh`. Same network wiring + the same 5-point live validation against `/subscriptions/aliencouncil.com/items`. Commit submodule + bump pointer.

- [ ] **Step 1:** Derive `pull-feeds.py` from aliencouncil's scraper (preserve its exact cache logic; no cold archive).
- [ ] **Step 2:** Point `run-scraper.sh` at pull-feeds.py.
- [ ] **Step 3:** Add the vpn-proxy_default network + DATAHUB_API to its cron compose.
- [ ] **Step 4:** Rebuild cron, run one cycle (as Task 1 Step 4, substituting the aliencouncil path).
- [ ] **Step 5:** Run the full 5-point validation (a–e) against `aliencouncil.com`.
- [ ] **Step 6:** Commit submodule + bump pointer.

---

### Task 3: Migrate broadwayshowgirls.com + live validation

Derived from bsg's `scrape-feeds.py`. **Deltas (bsg is the outlier):** **120-cap** (not 200), **JSON `seen-urls.json`** (not text), `beats` config key (not `beat_patterns`), `DEFAULT_BEAT = "industry"`, no cold archive, no priority. The scraper runs via `run-worker.sh scrape` (`*/30`) inside the worker container — so the network join + DATAHUB_API go on the WORKER service (the one that runs `run-worker.sh`), and Step 2 edits whatever `run-worker.sh scrape` dispatches to so it calls pull-feeds.py. `SITE_HOST = "broadwayshowgirls.com"`. Preserve the JSON seen-urls format exactly. Same 5-point validation against `/subscriptions/broadwayshowgirls.com/items`.

- [ ] **Step 1:** Derive `pull-feeds.py` from bsg's scraper (120-cap, JSON seen-urls, `beats` key, DEFAULT_BEAT="industry").
- [ ] **Step 2:** Make `run-worker.sh scrape` invoke pull-feeds.py.
- [ ] **Step 3:** Add vpn-proxy_default network + DATAHUB_API to the worker/cron service that runs scrape.
- [ ] **Step 4:** Rebuild, run one cycle.
- [ ] **Step 5:** Run the 5-point validation against `broadwayshowgirls.com` (note: 120-cap, JSON seen-urls intact).
- [ ] **Step 6:** Commit submodule + bump pointer.

---

### Task 4: Migrate saveusfarms.com RSS + live validation

Derived from saveusfarms' `scrape-feeds.py`. **Deltas:** 200-cap, text seen-urls, cold archive YES, no priority floor, `beat_patterns`, non-blocking lock (preserve it). `SITE_HOST = "saveusfarms.com"`; `DEFAULT_BEAT` = its generic default. Cron `*/30` `run-scraper.sh`. **War Room (NASS/EIA datasets) is OUT OF SCOPE for this task** — leave `ops/scripts/fetch-data.sh` and `site/scripts/fetch-data.mjs` untouched (deferred until keys exist). Same 5-point validation against `/subscriptions/saveusfarms.com/items`.

- [ ] **Step 1:** Derive `pull-feeds.py` (200-cap, text seen-urls, cold archive, non-blocking lock preserved).
- [ ] **Step 2:** Point `run-scraper.sh` at pull-feeds.py (do NOT touch fetch-data.sh).
- [ ] **Step 3:** Add vpn-proxy_default network + DATAHUB_API to the cron service.
- [ ] **Step 4:** Rebuild, run one cycle.
- [ ] **Step 5:** Run the 5-point validation against `saveusfarms.com`.
- [ ] **Step 6:** Commit submodule + bump pointer. Note in the commit that War Room datasets remain on the legacy path pending NASS/EIA keys.

---

### Task 5: Migrate sinderella.org brief-builder to hub datasets + live validation

sinderella is different — it aggregates structured signals into a daily markdown brief via local LLM. Replace its RAW API fetches with hub `/datasets/*` calls, keeping local synthesis. The keyless signals are available from the hub; FRED + GNews are NOT (no keys) → keep sinderella's existing fallback for those two only.

**Files (in `sites/sinderella.org/`):**
- Modify: `ops/llm/roles/brief_builder.py` — swap the raw-fetch bodies of these functions to call the hub, mapping hub dataset payloads to the same return shape the rest of brief_builder expects:
  - `get_moon_data` + `get_planetary_positions` → `GET /datasets/ephemeris` (payload has moon_phase_pct, moon_sign, sun_sign, planet_longitudes). Keep the local `ephem` import ONLY as a fallback if the hub is unreachable.
  - `get_solar_activity` → `GET /datasets/kindex` (+ `/datasets/solar-xrays`).
  - `get_solar_wind` → if a hub solar-wind dataset exists use it; else keep current (note: Plan 2 seeded kindex + solar-xrays, NOT solar-wind — so KEEP get_solar_wind on its current SWPC fetch for now, or add a solar-wind source to the hub in a follow-up. For THIS task, leave get_solar_wind as-is.)
  - `get_weather_signal` → `GET /datasets/weather-alerts`.
  - `get_earthquake_signal` → `GET /datasets/quakes`.
  - `get_tidal_signal` → if the hub has a tides dataset use it; Plan 2 did NOT seed tides → leave `get_tidal_signal` as-is for now.
  - `get_upcoming_launches` → `GET /datasets/launches`.
  - `get_economic_pulse` (FRED) and `fetch_news_from_gnews` (GNews) → LEAVE AS-IS (no keys; they already self-disable/fallback).
- Modify: `docker-compose.yml` — the worker/cron service that runs brief-builder joins vpn-proxy_default + DATAHUB_API env.

**Interfaces:** brief-builder produces the same `ops/signals/brief-YYYY-MM-DD.md`, now sourcing keyless signals from the hub.

- [ ] **Step 1:** Add a small hub helper in brief_builder.py: `_hub_dataset(key)` → `GET {DATAHUB_API}/datasets/{key}?limit=1` returning the latest record's `payload` (or `None` on failure). Stdlib urllib, 15s timeout.
- [ ] **Step 2:** Rewrite the bodies of `get_moon_data`, `get_planetary_positions`, `get_solar_activity`, `get_weather_signal`, `get_earthquake_signal`, `get_upcoming_launches` to map the corresponding hub dataset payload to their existing return structure; on hub failure (None), fall back to the existing local/raw implementation (keep that code as the `except`/fallback branch). Leave `get_solar_wind`, `get_tidal_signal`, `get_economic_pulse`, `fetch_news_from_gnews`, `fetch_news_from_rss` UNCHANGED.
- [ ] **Step 3:** Add the vpn-proxy_default network + DATAHUB_API to the brief-builder's service in docker-compose.yml.
- [ ] **Step 4: Rebuild + run one brief-builder cycle**
```bash
cd /home/jesse/projects/domains/sites/sinderella.org
docker compose --env-file /home/jesse/projects/domains/.env up -d --build cron   # or the worker service name
docker compose --env-file /home/jesse/projects/domains/.env exec -T cron bash ops/scripts/run-worker.sh brief-builder
```
- [ ] **Step 5: VALIDATE**
```bash
cd /home/jesse/projects/domains/sites/sinderella.org
# (a) today's brief was written and is non-trivial
ls -la ops/signals/brief-$(date -u +%F).md && wc -l ops/signals/brief-$(date -u +%F).md
# (b) the brief contains hub-sourced signals (moon sign, a quake/launch/weather mention) — spot check
grep -iE "moon|zodiac|launch|earthquake|kp|alert" ops/signals/brief-$(date -u +%F).md | head
# (c) the container reached the hub datasets
docker compose --env-file /home/jesse/projects/domains/.env exec -T cron sh -c 'python3 -c "import urllib.request,json; print(json.load(urllib.request.urlopen(\"http://datahub-api:4760/datasets/ephemeris?limit=1\",timeout=10))[\"records\"][0][\"payload\"][\"moon_sign\"])"'
# (d) hub VPN path for the keyless gov datasets (egress)
curl -s "http://127.0.0.1:4760/egress?limit=30" | python3 -c "import sys,json; ev=json.load(sys.stdin)['events']; print('dataset vpn egress:', [(e['source_id'],e['exit_ip']) for e in ev if e['policy']=='vpn' and e['status']=='ok'][:3])"
# (e) fail-safe: stop hub, run again, confirm brief still generates via fallbacks (exit 0, brief exists)
docker stop datahub-api; docker compose --env-file /home/jesse/projects/domains/.env exec -T cron bash ops/scripts/run-worker.sh brief-builder; echo "exit=$?"; docker start datahub-api
```
Expected: brief generated; contains hub-sourced astro/space/weather signals; container reaches the hub; egress shows the VPN path for the gov datasets; with the hub down the brief STILL generates via the local fallbacks (resilience preserved). 
- [ ] **Step 6:** Commit submodule + bump pointer.

---

## Self-Review

**Spec coverage (vs design doc migration phase):**
- Per-site puller writing the same cache, byte-compatible → derive-from-own-scraper approach (Tasks 1-4). ✓
- Migration order + parity gate + rollback (old scraper kept) → each task. ✓
- Beat classification stays site-local → reuses each site's `classify_beat` + `DEFAULT_BEAT`. ✓
- All external collection behind the hub VPN; puller hits only the hub → validation step (b)/(c)/(d). ✓
- Fail-safe (hub down → keep cache / brief still builds, never scrape externally) → transformation §2 + validation (e). ✓
- saveusfarms War Room + sinderella brief-builder (datasets) → Task 4 note (War Room deferred for keys) + Task 5 (brief-builder migrated for keyless signals, FRED/GNews left on fallback). ✓

**Placeholder scan:** No TBD. Tasks 2-4 reference Task 1's template with explicit per-site deltas (caps, seen-url format, archive, default beat, cron path) — the implementer derives each puller from that site's own scraper, which is concrete, not a placeholder.

**Consistency:** `fetch_hub_items()`/`_hub_dataset()` call `DATAHUB_API` (default `http://datahub-api:4760`) consistently; the network join (`vpn-proxy_default` external) is identical across tasks; the schema `{title,url,published_iso,summary,source,beat}` is the invariant gate for all 4 news sites; the 5-point live validation (written+schema / hub-not-external / reachability / VPN-path / fail-safe) is applied to every site.

**Controller note:** Jesse asked to run a cycle and validate (logs, VPN path) after EACH site. The controller should personally re-run the key validation (egress VPN path + news-feed schema + fail-safe) after each task's subagent reports, before starting the next site — and STOP to fix the pattern if site 1 (americastrikes) reveals any issue, since Tasks 2-5 reuse it.
