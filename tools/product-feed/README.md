# product-feed

Shared, verified Amazon product inventory for the fleet. A central collector
discovers ASINs, verifies each one on its real Amazon product page, and stores
an untagged canonical URL such as `https://www.amazon.com/dp/B012345678`.

Search pages are discovery inputs only. Search URLs are never product records,
affiliate destinations, or publishing fallbacks.

## How it works

```text
Amazon search (discovery only)
          |
          v
open and verify /dp/<ASIN>
          |
          v
shared products table (canonical URL, title, image, price, rating, tags)
          |
          +---- WeirdGirlStore reviews its matching products
          |
          +---- WeirdAssStuff reviews its matching products
          |
          +---- future sites review their own matching products
                        |
                        v
              site queue -> site publisher
                        |
                        v
          /dp/<ASIN>?tag=<that-site-tag>
```

Selection state is per site. WeirdGirlStore can accept a product while
WeirdAssStuff rejects it, or both can accept it; neither decision consumes the
product for the other site. Each publisher appends its own Associates tag only
when it generates the site's redirect.

The collector compares every subscription's `available` inventory with its
configured target. It calls Amazon only when at least one site is below target,
then stores verified products that match the deficient sites' tags.

## Data model

The SQLite database at `/data/product-feed.db` contains:

- `products`: one row per ASIN with canonical `/dp/` URL, current product
  details, shared tags, discovery provenance, and verification timestamps.
- `site_product_state`: independent `reviewing`, `queued`, `publishing`,
  `rejected`, or `published` state for each site/product pair, plus the site's
  catalog decision and copy.
- `candidates`: the original passive queue, retained temporarily for backward
  compatibility with callers that have not migrated.

The API itself derives the Amazon URL from the validated ASIN. It ignores any
URL submitted by a producer, which prevents a search URL from entering the new
inventory path.

## Registry

`registry/subscriptions.yaml` defines each site's matching tags, target
available depth, and normal review batch size.

`registry/sources.yaml` defines the Amazon discovery searches and the tags
assigned to verified results. A query may serve several sites when its tags
overlap their subscriptions.

## Product API

Base URL on the host is `http://127.0.0.1:4761`. Containers on the
`product-feed_default` network use `http://product-feed-api:4761` (or `api`
inside this Compose project).

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Service health and registered sites |
| POST | `/products` | Insert or refresh a verified ASIN; URL is derived by the API |
| GET | `/products` | List shared verified products |
| GET | `/products/{asin}` | Read one exact product |
| GET | `/inventory/stats` | Shared and per-site inventory totals |
| GET | `/subscriptions/{site}/inventory-depth` | Available/reviewing/queued/published counts and target |
| POST | `/subscriptions/{site}/products/next-review` | Atomically claim one matching product for that site's review |
| POST | `/subscriptions/{site}/products/{asin}/queue` | Accept it into that site's publishing queue |
| POST | `/subscriptions/{site}/products/{asin}/reject` | Reject it for that site only |
| POST | `/subscriptions/{site}/products/{asin}/review-release` | Release an interrupted review |
| POST | `/subscriptions/{site}/products/publish-next` | Claim the site's oldest accepted product for publishing |
| POST | `/subscriptions/{site}/products/{asin}/published` | Mark the site's publish complete |
| POST | `/subscriptions/{site}/products/{asin}/publish-release` | Return a failed publish to that site's queue |

The legacy `/candidates`, `/subscriptions/{site}/next`, `/depth`, and `/stats`
routes remain available during migration, but new integrations should not use
them.

## Run

The collector requires the existing `vpn-proxy_default` Docker network and its
`vpn-us` HTTP proxy. It uses CloakBrowser through that proxy and stops without
bypass attempts if Amazon presents a challenge.

```bash
cd tools/product-feed
docker compose up -d --build
curl http://127.0.0.1:4761/health
curl http://127.0.0.1:4761/inventory/stats
docker compose logs -f collector
```

The API has a health check; Compose waits for it before starting the collector.
Collector browser state and query rotation are persisted in a named volume.

## Site integration

`scripts/site_client.py` is the shared client:

```bash
python3 scripts/site_client.py claim \
  --site weirdgirlstore.com \
  --count 4 \
  --output-dir /tmp/product-review

python3 scripts/site_client.py decide \
  --site weirdgirlstore.com \
  --candidate /tmp/product-review/B012345678.json \
  --decision /tmp/product-review/B012345678-decision.json
```

A site's scout only judges brand fit and writes site-specific catalog copy.
Its publisher claims that site's accepted queue, builds the redirect with the
site's affiliate tag, applies/builds/commits, then marks the ASIN published.

## Tests

```bash
cd tools/product-feed
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -e .
.venv/bin/python -m pytest -q
```

Or test the already-built pinned image:

```bash
docker run --rm \
  -v "$PWD/tests:/app/tests:ro" \
  product-feed-api pytest -q /app/tests
```
