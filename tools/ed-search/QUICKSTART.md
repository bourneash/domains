# ed-search — Quickstart

CLI for hitting **expireddomains.net** with your account. Runs saved-search profiles, dumps CSVs.

## 1. One-time setup

```bash
cd /home/jesse/projects/domains/tools/ed-search
python3 -m venv .venv
.venv/bin/pip install -e .
```

Add your creds to `/home/jesse/projects/domains/.env`:

```
ED_USERNAME=your_login
ED_PASSWORD=your_password
```

## 2. Log in (first time + whenever the session dies)

```bash
.venv/bin/ed-search login
```

If your account has email MFA, you'll see:

```
MFA required. Check email for the code, then run:
  ed-search verify <code>
```

Check email → run `ed-search verify 123456`. Cookies are persisted to `~/.cache/ed-search/cookies.txt` and survive across runs (typically days; the `rememberme` cookie lasts ~1 year).

After the first MFA pass, the site usually trusts your IP and skips MFA on subsequent re-logins.

## 3. Daily use

```bash
.venv/bin/ed-search whoami                          # confirm session is alive
.venv/bin/ed-search profiles                        # list available profiles
.venv/bin/ed-search run combined-recent --pages 5   # run a profile, walk 5 pages
.venv/bin/ed-search run aged-com-buildable --pages 3
```

Output: `out/<profile>-<UTC-timestamp>.csv`.

### Ad-hoc query (no profile)

Open a saved search on the site in your browser, copy everything after `?` in the URL, and:

```bash
.venv/bin/ed-search run --path /domains/expiredcom/ \
  --inline 'flimit=25&fmaxlength=12&fhidewithhyphen=1&fdomainpop=10' \
  --pages 3
```

## 4. Bundled profiles

| name | path | what it pulls |
|------|------|---------------|
| `combined-recent` | `/domains/combinedexpired/` | All-TLD deleted feed, last 7 days |
| `aged-com-buildable` | `/domains/expiredcom/` | Short clean .com, has backlinks |
| `dropped-finance` | `/domains/expiredcom/` | Recently deleted .com w/ finance keywords |
| `pending-delete-short` | `/domains/caughtdomains/` | Caught-domains list, short + clean |

Profiles are JSON in `profiles/` — copy and tweak. Each is just `{path, params, description}`.

## 5. CSV columns

Common fields you'll see (varies slightly per list view):

| column | meaning |
|--------|---------|
| `domain` | the domain name |
| `le` | length (chars) |
| `bl` | external backlinks |
| `dp` | domainpop (referring domains) |
| `wby` | first Wayback Machine year |
| `aby` | first Archive year (registration history) |
| `acr` | Archive.org snapshots count |
| `mmgr` | Majestic mentions |
| `dmoz` | DMOZ listings |
| `reg` | registrar fee tier |
| `c n o b i d` | availability of `.com .net .org .biz .info .de` |
| `add_date` | date added to the list |
| `status` | available / pending / etc |

## 6. Asking Claude to find gems for you

There's a Claude skill `ed-domain-scout` that runs profiles, ranks rows, and writes a buy-recommendation report. From any Claude Code session in this repo:

```
/ed-domain-scout
```

It will pull fresh CSVs, score each row for buildability, and produce a markdown shortlist with proposed site concepts.

## 7. Troubleshooting

| symptom | fix |
|---------|-----|
| `session: NOT logged in` | Run `ed-search login` (and `verify <code>` if MFA prompts) |
| `MFA verification failed — code rejected or expired` | Re-run `login` to get a new code |
| `0 rows` | The list path may not exist for that view. Try a bundled profile first; check `member.expireddomains.net` in browser for the actual URL. |
| Cookies not auth'ing | Delete `~/.cache/ed-search/cookies.txt` and re-login |

## Files

```
tools/ed-search/
├── pyproject.toml
├── README.md          # full reference
├── QUICKSTART.md      # this file
├── profiles/*.json    # saved search profiles
├── src/ed_search/
│   ├── cli.py         # Click commands
│   ├── client.py      # auth + session
│   ├── parse.py       # HTML → rows
│   └── profiles.py
└── out/               # CSVs land here (gitignored)
```
