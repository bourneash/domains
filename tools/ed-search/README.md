# ed-search

Authenticated CLI for **expireddomains.net**. Runs named saved-search profiles against your paid account and dumps CSVs you can grep, sort, and feed into the rest of the `domains/` workflow.

> No public API exists. This logs in with your real credentials, persists the session cookie locally, and parses the same HTML pages you'd browse manually. Respect the site's ToS — keep it to your own searches at human-ish rates.

## Install

```bash
cd /home/jesse/projects/domains/tools/ed-search
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

Make sure `/home/jesse/projects/domains/.env` has:

```
ED_USERNAME=your_login
ED_PASSWORD=your_password
```

## Usage

```bash
ed-search login                       # logs in once, caches session cookie
ed-search profiles                    # list available profiles
ed-search run aged-aviation           # run profile, write CSV under ./out/
ed-search run aged-aviation --pages 5 # paginate
ed-search run --inline 'tld=com&minage=10&minbl=20'  # one-off, no profile
```

Profiles live in `profiles/*.json`. Each is a thin dict of expireddomains.net query params — see `profiles/aged-aviation.json` for a starter.

## Files

- `src/ed_search/cli.py` — Click entrypoints
- `src/ed_search/client.py` — auth + HTTP session
- `src/ed_search/parse.py` — HTML → rows
- `src/ed_search/profiles.py` — load profile JSON
- `~/.cache/ed-search/cookies.json` — persisted session

## Output

CSVs in `./out/<profile>-<UTC-timestamp>.csv` with columns: `domain, length, bl, dp, age, tld, status, registrar, end_date, list, type`. Exact columns depend on which expireddomains list page is being scraped.
