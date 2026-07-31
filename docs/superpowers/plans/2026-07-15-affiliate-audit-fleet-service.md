# Affiliate Audit Fleet Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare-curl `affiliate-editor` LLM role with a shared, deterministic
`tools/affiliate-audit/` service that checks affiliate links via CloakBrowser, and
invokes an LLM resolution agent only when a product is actually flagged.

**Architecture:** A Python orchestrator (`run.py`) per site: `discover.mjs` (Node/tsx,
imports the site's `affiliate.ts` for type-safe product data) → `checker.py`
(CloakBrowser, one browser session per run, paced) → `classify.py` (pure, deterministic
verdicts) → `state.py` (per-site consecutive-run tracking) → `resolve.py` (spawns a
turn-capped `claude -p` agent only on actionable verdicts). Config is a merged
default + per-site YAML.

**Tech Stack:** Python 3 stdlib + PyYAML (already present, confirmed
`python3 -c "import yaml"` succeeds), the existing `cloakbrowser` package (via
`tools/creator-connections/cc_lib.py`), Node/tsx (already a devDependency in every
site's `site/package.json`), `claude -p` CLI (already the fleet's headless-agent
mechanism, see `ops/scripts/run-role.sh`).

## Global Constraints

- Shared code lives in `tools/affiliate-audit/` (domains repo). Per-site config/state
  lives in `sites/<domain>/ops/` (that site's own repo) — same split as `fleet-smoke`.
- Zero LLM tokens on a clean run — `discover.mjs`/`checker.py`/`classify.py`/`state.py`
  are plain scripts, no agent involved.
- `checker.py` must reuse `tools/creator-connections/cc_lib.py`'s `launch()` — do not
  write a second CloakBrowser driver.
- Pacing between product checks: jittered 12–25s (`config.default.yaml`,
  `pacing.min_delay_s`/`max_delay_s`), one browser session reused for the whole run.
- `campaignOnly: true` products are checked for redirect health only, never
  auto-replaced by the resolution agent (route to "outstanding" instead).
- Resolution agent commits are turn-capped (`resolution.max_agent_turns`, default 20)
  and attempt-capped (`resolution.max_search_attempts`, default 3) — passed as an
  explicit budget in the invocation, not a prompt suggestion.
- The resolution agent never pushes directly to `main` or runs a deploy itself — it
  commits its fix and creates `.deploy-needed`, letting the existing `deployer` role
  (which already owns push + live-smoke-verify + rollback-on-red-smoke) ship it. This
  reuses proven safety machinery instead of duplicating it in a second role.
- Every run posts one Slack summary line via `ops/scripts/notify-slack.sh` (already
  present, silent no-op if `SLACK_BOT_TOKEN` unset). Every resolution attempt posts
  its own line (resolved: old→new+reason, or outstanding: verdict+evidence+task path).

---

## File structure

```
tools/affiliate-audit/
  discover.mjs            # tsx script: PRODUCTS[] -> JSON on stdout
  config.py                # load + deep-merge default/site YAML config
  config.default.yaml      # fleet defaults
  checker.py                # CloakBrowser-driven per-product landed-page check
  classify.py                # pure verdict function (evidence + config -> verdict)
  state.py                   # per-site consecutive-run state read/update/write
  resolve.py                  # build resolution-agent prompt + spawn `claude -p`
  run.py                       # orchestrator entrypoint (--site, --dry-run)
  tests/
    test_config.py
    test_classify.py
    test_state.py
    test_checker.py           # fake-page unit tests, no real browser/network
    fixtures/
      affiliate.fixture.ts    # tiny 2-product fixture for discover.mjs test
  tests/test_discover.mjs.sh  # shell test invoking discover.mjs against the fixture

sites/totaljerks.com/ops/
  affiliate-audit.yaml (optional, added only if an override is needed)
  state/affiliate-audit.json   # replaces affiliate-oos.json
```

---

### Task 1: `discover.mjs` — registry-to-JSON extractor

**Files:**
- Create: `tools/affiliate-audit/discover.mjs`
- Create: `tools/affiliate-audit/tests/fixtures/affiliate.fixture.ts`
- Create: `tools/affiliate-audit/tests/test_discover.mjs.sh`

**Interfaces:**
- Produces: invoked as `npx tsx <abs-path-to-discover.mjs> <abs-path-to-affiliate.ts>`,
  writes a JSON array to stdout: each element
  `{id, name, brand, category, price, asin, amazonImageId, searchQuery, image, blurb,
  ribbon, campaignOnly}` (fields mirror `AffiliateProduct` in `site/src/lib/affiliate.ts`;
  `asin`/`amazonImageId`/`ribbon` may be `null` if absent; `campaignOnly` defaults to
  `false` if absent).

- [ ] **Step 1: Write the fixture file**

```typescript
// tools/affiliate-audit/tests/fixtures/affiliate.fixture.ts
export const AMAZON_TAG = 'fixture-20';

export type CategorySlug = 'hard-jerks' | 'soft-jerks';
export type Ribbon = 'EDITORS_PICK';

export interface AffiliateProduct {
  id: string;
  name: string;
  brand: string;
  category: CategorySlug;
  price: string;
  asin?: string;
  amazonImageId?: string;
  searchQuery: string;
  image: `/products/${string}`;
  blurb: string;
  ribbon?: Ribbon;
  hasImage?: boolean;
  campaignOnly?: boolean;
}

export const PRODUCTS: AffiliateProduct[] = [
  {
    id: 'fixture-one',
    name: 'Fixture One',
    brand: 'FixtureCo',
    category: 'hard-jerks',
    price: '$9.99',
    asin: 'B00FIXTURE1',
    searchQuery: 'fixture one jerkbait',
    image: '/products/fixture-one.jpg',
    blurb: 'A fixture product for testing.',
    ribbon: 'EDITORS_PICK',
  },
  {
    id: 'fixture-two',
    name: 'Fixture Two',
    brand: 'FixtureCo',
    category: 'soft-jerks',
    price: '$4.99',
    searchQuery: 'fixture two soft jerkbait',
    image: '/products/fixture-two.jpg',
    blurb: 'A second fixture product, no ASIN, campaign-only.',
    campaignOnly: true,
  },
];
```

- [ ] **Step 2: Write `discover.mjs`**

```javascript
#!/usr/bin/env node
// Import a site's src/lib/affiliate.ts and dump PRODUCTS[] as JSON on stdout.
// Generic by design — usable by any tool that needs the registry as data, not
// just affiliate-audit. Invoke via tsx: `npx tsx discover.mjs <path-to-affiliate.ts>`
//
// We import (not regex-parse) so the data is type-checked at import time and
// we never eval/reach into file contents by hand — same rationale as
// site/scripts/generate-redirects.ts.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: discover.mjs <path-to-affiliate.ts>');
    process.exit(1);
  }
  const abs = resolve(target);
  const mod = await import(pathToFileURL(abs).href);
  const products = (mod.PRODUCTS || []).map((p) => ({
    id: p.id,
    name: p.name,
    brand: p.brand,
    category: p.category,
    price: p.price,
    asin: p.asin ?? null,
    amazonImageId: p.amazonImageId ?? null,
    searchQuery: p.searchQuery,
    image: p.image,
    blurb: p.blurb,
    ribbon: p.ribbon ?? null,
    campaignOnly: p.campaignOnly ?? false,
  }));
  process.stdout.write(JSON.stringify(products));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Write the shell test**

```bash
#!/usr/bin/env bash
# tools/affiliate-audit/tests/test_discover.mjs.sh
# Runs discover.mjs against the fixture using totaljerks.com's local tsx
# (no external deps needed by the fixture, so any site's node_modules works).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT_DIR="$(dirname "$HERE")"
SITE_DIR="$(cd "$AUDIT_DIR/../../sites/totaljerks.com/site" && pwd)"

OUT=$(cd "$SITE_DIR" && npx tsx "$HERE/../discover.mjs" "$HERE/fixtures/affiliate.fixture.ts")

echo "$OUT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert len(data) == 2, f'expected 2 products, got {len(data)}'
assert data[0]['id'] == 'fixture-one'
assert data[0]['asin'] == 'B00FIXTURE1'
assert data[0]['ribbon'] == 'EDITORS_PICK'
assert data[1]['id'] == 'fixture-two'
assert data[1]['asin'] is None
assert data[1]['campaignOnly'] is True
print('OK: discover.mjs output matches fixture')
"
```

- [ ] **Step 4: Run the test to verify it fails first (script doesn't exist yet)**

Run: `chmod +x tools/affiliate-audit/tests/test_discover.mjs.sh && tools/affiliate-audit/tests/test_discover.mjs.sh`
Expected: FAIL — `discover.mjs` not found (only run this before Step 2's file exists;
if executing tasks in order, confirm failure by temporarily renaming `discover.mjs`,
or simply proceed — Step 2 already created it, so skip straight to Step 5).

- [ ] **Step 5: Run the test to verify it passes**

Run: `tools/affiliate-audit/tests/test_discover.mjs.sh`
Expected: `OK: discover.mjs output matches fixture`

- [ ] **Step 6: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/affiliate-audit/discover.mjs tools/affiliate-audit/tests/fixtures/affiliate.fixture.ts tools/affiliate-audit/tests/test_discover.mjs.sh
git commit -m "feat(affiliate-audit): add discover.mjs registry-to-JSON extractor"
```

---

### Task 2: Config loading (`config.py` + `config.default.yaml`)

**Files:**
- Create: `tools/affiliate-audit/config.default.yaml`
- Create: `tools/affiliate-audit/config.py`
- Test: `tools/affiliate-audit/tests/test_config.py`

**Interfaces:**
- Produces: `load_config(site_dir: pathlib.Path) -> dict` with keys `checks`,
  `pacing`, `resolution`, `slack` (see schema below). Deep-merges
  `<site_dir>/ops/affiliate-audit.yaml` (if present) over `config.default.yaml`.

- [ ] **Step 1: Write `config.default.yaml`**

```yaml
checks:
  prime_required: true
  min_rating: 4.0
  oos_grace_runs: 2
  dead_grace_runs: 1
  broken_redirect_grace_runs: 1
  no_prime_grace_runs: 2
  low_rating_grace_runs: 2
pacing:
  min_delay_s: 12
  max_delay_s: 25
resolution:
  max_search_attempts: 3
  max_agent_turns: 20
  model: claude-sonnet-4-6
slack:
  channel_env: SLACK_CHANNEL_TOTALJERKS
  channel_default: null
```

- [ ] **Step 2: Write the failing test**

```python
# tools/affiliate-audit/tests/test_config.py
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import config  # noqa: E402


def test_load_config_defaults_only():
    site_dir = Path(tempfile.mkdtemp())
    cfg = config.load_config(site_dir)
    assert cfg["checks"]["min_rating"] == 4.0
    assert cfg["pacing"]["min_delay_s"] == 12
    assert cfg["resolution"]["max_agent_turns"] == 20


def test_load_config_site_override_merges_not_replaces():
    site_dir = Path(tempfile.mkdtemp())
    (site_dir / "ops").mkdir()
    (site_dir / "ops" / "affiliate-audit.yaml").write_text(
        "checks:\n  min_rating: 4.5\n"
    )
    cfg = config.load_config(site_dir)
    assert cfg["checks"]["min_rating"] == 4.5
    # untouched sibling keys survive the merge
    assert cfg["checks"]["oos_grace_runs"] == 2
    assert cfg["pacing"]["min_delay_s"] == 12
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'config'`

- [ ] **Step 4: Write `config.py`**

```python
"""Load fleet-default + per-site affiliate-audit config, deep-merged."""
from pathlib import Path

import yaml

_DEFAULT_PATH = Path(__file__).resolve().parent / "config.default.yaml"


def _deep_merge(base: dict, override: dict) -> dict:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_config(site_dir: Path) -> dict:
    """site_dir is a site's repo root, e.g. sites/totaljerks.com/."""
    default = yaml.safe_load(_DEFAULT_PATH.read_text()) or {}
    override_path = Path(site_dir) / "ops" / "affiliate-audit.yaml"
    if override_path.exists():
        override = yaml.safe_load(override_path.read_text()) or {}
        return _deep_merge(default, override)
    return default
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_config.py -v`
Expected: 2 passed

- [ ] **Step 6: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/affiliate-audit/config.py tools/affiliate-audit/config.default.yaml tools/affiliate-audit/tests/test_config.py
git commit -m "feat(affiliate-audit): add merged fleet/per-site config loader"
```

---

### Task 3: `classify.py` — deterministic verdicts

**Files:**
- Create: `tools/affiliate-audit/classify.py`
- Test: `tools/affiliate-audit/tests/test_classify.py`

**Interfaces:**
- Consumes: an `evidence` dict (produced by `checker.py` in Task 5, but this task
  defines and depends only on its shape — no import of `checker.py`):
  `{"redirect_ok": bool, "body": str, "prime": bool | None, "rating": float | None}`
  and a `config["checks"]` dict (from Task 2).
- Produces: `classify(evidence: dict, checks_cfg: dict) -> str`, one of
  `"ok" | "dead" | "oos" | "no_prime" | "low_rating" | "broken_redirect" | "inconclusive"`.

- [ ] **Step 1: Write the failing test**

```python
# tools/affiliate-audit/tests/test_classify.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import classify  # noqa: E402

CHECKS = {
    "prime_required": True,
    "min_rating": 4.0,
}


def _evidence(**overrides):
    base = {"redirect_ok": True, "body": "normal product page", "prime": True, "rating": 4.6}
    base.update(overrides)
    return base


def test_broken_redirect_takes_priority():
    ev = _evidence(redirect_ok=False)
    assert classify.classify(ev, CHECKS) == "broken_redirect"


def test_captcha_is_inconclusive_even_if_other_markers_present():
    ev = _evidence(body="please solve this captcha, Robot Check")
    assert classify.classify(ev, CHECKS) == "inconclusive"


def test_dead_soft_404():
    ev = _evidence(body="Sorry! We couldn't find that page")
    assert classify.classify(ev, CHECKS) == "dead"


def test_oos():
    ev = _evidence(body="currently unavailable")
    assert classify.classify(ev, CHECKS) == "oos"


def test_no_prime():
    ev = _evidence(prime=False)
    assert classify.classify(ev, CHECKS) == "no_prime"


def test_low_rating():
    ev = _evidence(rating=3.2)
    assert classify.classify(ev, CHECKS) == "low_rating"


def test_ok():
    ev = _evidence()
    assert classify.classify(ev, CHECKS) == "ok"


def test_prime_not_required_when_config_disables_it():
    ev = _evidence(prime=False)
    assert classify.classify(ev, {"prime_required": False, "min_rating": 4.0}) == "ok"


def test_unknown_rating_is_not_low_rating():
    ev = _evidence(rating=None)
    assert classify.classify(ev, CHECKS) == "ok"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_classify.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'classify'`

- [ ] **Step 3: Write `classify.py`**

```python
"""Deterministic verdict for one product's checked evidence. Pure function —
no I/O, no browser — so it's cheap to unit test exhaustively."""

SOFT_404_MARKERS = (
    "sorry! we couldn't find that page",
    "looking for something",
    "dog of the day",
    "404 not found",
)
OOS_MARKER = "currently unavailable"
ANTI_BOT_MARKERS = ("captcha", "robot check")


def classify(evidence: dict, checks_cfg: dict) -> str:
    if not evidence.get("redirect_ok", True):
        return "broken_redirect"

    body = (evidence.get("body") or "").lower()

    if any(m in body for m in ANTI_BOT_MARKERS):
        return "inconclusive"

    if any(m in body for m in SOFT_404_MARKERS):
        return "dead"

    if OOS_MARKER in body:
        return "oos"

    if checks_cfg.get("prime_required", True) and evidence.get("prime") is False:
        return "no_prime"

    rating = evidence.get("rating")
    min_rating = checks_cfg.get("min_rating")
    if rating is not None and min_rating is not None and rating < min_rating:
        return "low_rating"

    return "ok"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_classify.py -v`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/affiliate-audit/classify.py tools/affiliate-audit/tests/test_classify.py
git commit -m "feat(affiliate-audit): add deterministic classify() verdict function"
```

---

### Task 4: `state.py` — per-site consecutive-run tracking

**Files:**
- Create: `tools/affiliate-audit/state.py`
- Test: `tools/affiliate-audit/tests/test_state.py`

**Interfaces:**
- Consumes: verdict strings from `classify.classify()` (Task 3): one of
  `"ok" | "dead" | "oos" | "no_prime" | "low_rating" | "broken_redirect" | "inconclusive"`.
- Produces:
  - `load_state(site_dir: Path) -> dict` (empty dict if file missing)
  - `save_state(site_dir: Path, state: dict) -> None`
  - `update_state(state: dict, product_id: str, verdict: str, today: str, checks_cfg: dict) -> tuple[dict, bool]`
    returns `(new_state, actionable)`. `today` is caller-supplied (`YYYY-MM-DD`
    string) — this module never calls `date.today()` itself, so it stays trivially
    testable and safe to call from a workflow context later.

- [ ] **Step 1: Write the failing test**

```python
# tools/affiliate-audit/tests/test_state.py
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import state  # noqa: E402

CHECKS = {
    "oos_grace_runs": 2,
    "dead_grace_runs": 1,
    "broken_redirect_grace_runs": 1,
    "no_prime_grace_runs": 2,
    "low_rating_grace_runs": 2,
}


def test_load_state_missing_file_returns_empty_dict():
    site_dir = Path(tempfile.mkdtemp())
    assert state.load_state(site_dir) == {}


def test_save_then_load_roundtrip():
    site_dir = Path(tempfile.mkdtemp())
    state.save_state(site_dir, {"widget": {"issue": "oos", "consecutive_runs": 1}})
    assert state.load_state(site_dir)["widget"]["consecutive_runs"] == 1


def test_dead_is_actionable_immediately():
    new_state, actionable = state.update_state({}, "widget", "dead", "2026-07-15", CHECKS)
    assert actionable is True
    assert new_state["widget"]["consecutive_runs"] == 1
    assert new_state["widget"]["issue"] == "dead"
    assert new_state["widget"]["first_seen"] == "2026-07-15"


def test_oos_needs_two_consecutive_runs():
    s1, actionable1 = state.update_state({}, "widget", "oos", "2026-07-01", CHECKS)
    assert actionable1 is False
    assert s1["widget"]["consecutive_runs"] == 1

    s2, actionable2 = state.update_state(s1, "widget", "oos", "2026-07-08", CHECKS)
    assert actionable2 is True
    assert s2["widget"]["consecutive_runs"] == 2
    assert s2["widget"]["first_seen"] == "2026-07-01"
    assert s2["widget"]["last_checked"] == "2026-07-08"


def test_ok_clears_prior_issue():
    s1, _ = state.update_state({}, "widget", "oos", "2026-07-01", CHECKS)
    s2, actionable = state.update_state(s1, "widget", "ok", "2026-07-08", CHECKS)
    assert actionable is False
    assert "widget" not in s2


def test_inconclusive_leaves_existing_progress_untouched():
    s1, _ = state.update_state({}, "widget", "oos", "2026-07-01", CHECKS)
    s2, actionable = state.update_state(s1, "widget", "inconclusive", "2026-07-08", CHECKS)
    assert actionable is False
    assert s2["widget"]["consecutive_runs"] == 1
    assert s2["widget"]["last_checked"] == "2026-07-01"


def test_issue_type_change_resets_streak():
    s1, _ = state.update_state({}, "widget", "oos", "2026-07-01", CHECKS)
    s2, actionable = state.update_state(s1, "widget", "dead", "2026-07-08", CHECKS)
    assert actionable is True  # dead_grace_runs == 1
    assert s2["widget"]["issue"] == "dead"
    assert s2["widget"]["consecutive_runs"] == 1
    assert s2["widget"]["first_seen"] == "2026-07-08"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_state.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'state'`

- [ ] **Step 3: Write `state.py`**

```python
"""Per-site, per-product consecutive-run tracking for affiliate-audit issues.
State file: <site_dir>/ops/state/affiliate-audit.json"""
import json
from pathlib import Path

_GRACE_KEY = {
    "oos": "oos_grace_runs",
    "dead": "dead_grace_runs",
    "broken_redirect": "broken_redirect_grace_runs",
    "no_prime": "no_prime_grace_runs",
    "low_rating": "low_rating_grace_runs",
}
NON_ACTIONABLE_VERDICTS = ("ok", "inconclusive")


def _state_path(site_dir: Path) -> Path:
    return Path(site_dir) / "ops" / "state" / "affiliate-audit.json"


def load_state(site_dir: Path) -> dict:
    path = _state_path(site_dir)
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def save_state(site_dir: Path, state_data: dict) -> None:
    path = _state_path(site_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state_data, indent=2, sort_keys=True) + "\n")


def update_state(
    state_data: dict, product_id: str, verdict: str, today: str, checks_cfg: dict
) -> tuple[dict, bool]:
    new_state = dict(state_data)
    entry = new_state.get(product_id)

    if verdict == "ok":
        new_state.pop(product_id, None)
        return new_state, False

    if verdict == "inconclusive":
        # Anti-bot wall: never advances or resets an existing streak.
        return new_state, False

    if entry is None or entry.get("issue") != verdict:
        entry = {
            "issue": verdict,
            "consecutive_runs": 1,
            "first_seen": today,
            "last_checked": today,
        }
    else:
        entry = dict(entry)
        entry["consecutive_runs"] += 1
        entry["last_checked"] = today

    new_state[product_id] = entry

    grace_runs = checks_cfg.get(_GRACE_KEY[verdict], 1)
    actionable = entry["consecutive_runs"] >= grace_runs
    return new_state, actionable
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_state.py -v`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/affiliate-audit/state.py tools/affiliate-audit/tests/test_state.py
git commit -m "feat(affiliate-audit): add per-site consecutive-run state tracker"
```

---

### Task 5: `checker.py` — CloakBrowser-driven per-product check

**Files:**
- Create: `tools/affiliate-audit/checker.py`
- Test: `tools/affiliate-audit/tests/test_checker.py`

**Interfaces:**
- Consumes: `tools/creator-connections/cc_lib.py`'s `launch()` (returns `(ctx, page)`)
  — imported via `sys.path.insert(0, ".../tools/creator-connections")`.
- Produces:
  - `check_product(page, base_url: str, product: dict, pacing_cfg: dict) -> dict`
    evidence shape (matches Task 3's `classify()` input, plus bookkeeping fields):
    `{"id": str, "go_url": str, "landed_url": str, "redirect_ok": bool, "body": str,
    "prime": bool | None, "rating": float | None, "checked_at": None}`.
    `page` is any object exposing `.goto(url, wait_until=..., timeout=...)`,
    `.url`, `.evaluate(js)`, and `.inner_text(selector)` — a real Playwright page in
    production, a fake in tests (see below), so this function never needs a live
    browser to unit test.
  - `pace()` — `time.sleep(random.uniform(min_delay_s, max_delay_s))`, called by
    `run.py` (Task 7) between products, not by `check_product` itself (keeps the
    check function synchronous and fast to test).

- [ ] **Step 1: Write the failing test (fake page, no real browser/network)**

```python
# tools/affiliate-audit/tests/test_checker.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import checker  # noqa: E402


class FakePage:
    def __init__(self, url, body, rating=None, prime=None, raise_on_goto=False):
        self.url = url
        self._body = body
        self._rating = rating
        self._prime = prime
        self._raise = raise_on_goto
        self.visited = []

    def goto(self, url, wait_until=None, timeout=None):
        self.visited.append(url)
        if self._raise:
            raise RuntimeError("net::ERR_CONNECTION_REFUSED")
        self.url = url

    def inner_text(self, selector):
        assert selector == "body"
        return self._body

    def evaluate(self, js):
        if "primeBadge" in js or "prime" in js.lower():
            return self._prime
        return self._rating


PRODUCT = {"id": "widget", "asin": "B00WIDGET1"}


def test_normal_product_ok_evidence():
    page = FakePage(url="https://amazon.com/dp/B00WIDGET1", body="Buy Widget now", rating=4.6, prime=True)
    ev = checker.check_product(page, "https://totaljerks.com", PRODUCT, {})
    assert ev["redirect_ok"] is True
    assert ev["body"] == "Buy Widget now"
    assert ev["rating"] == 4.6
    assert ev["prime"] is True
    assert ev["go_url"] == "https://totaljerks.com/go/widget/"


def test_goto_failure_is_broken_redirect():
    page = FakePage(url="", body="", raise_on_goto=True)
    ev = checker.check_product(page, "https://totaljerks.com", PRODUCT, {})
    assert ev["redirect_ok"] is False
    assert ev["body"] == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_checker.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'checker'`

- [ ] **Step 3: Write `checker.py`**

```python
"""CloakBrowser-driven per-product landed-page check. Reuses cc_lib.launch()
from tools/creator-connections rather than a second browser driver."""
import random
import sys
import time
from pathlib import Path

_CC_LIB_DIR = Path(__file__).resolve().parents[1] / "creator-connections"


def _ensure_cc_lib_on_path():
    p = str(_CC_LIB_DIR)
    if p not in sys.path:
        sys.path.insert(0, p)


def launch_browser():
    """Thin re-export so run.py only imports from checker, not cc_lib directly."""
    _ensure_cc_lib_on_path()
    import cc_lib

    return cc_lib.launch()


_RATING_JS = """
() => {
  const el = document.querySelector('#acrPopover, [data-hook="rating-out-of-text"], .a-icon-alt');
  if (!el) return null;
  const text = el.getAttribute('title') || el.textContent || '';
  const m = text.match(/([\\d.]+)\\s*out of/i);
  return m ? parseFloat(m[1]) : null;
}
"""

_PRIME_JS = """
() => !!document.querySelector('#primeBadge, .a-icon-prime, [aria-label*="Prime" i]')
"""


def check_product(page, base_url: str, product: dict, pacing_cfg: dict) -> dict:
    go_url = f"{base_url.rstrip('/')}/go/{product['id']}/"
    evidence = {
        "id": product["id"],
        "go_url": go_url,
        "landed_url": None,
        "redirect_ok": True,
        "body": "",
        "prime": None,
        "rating": None,
        "checked_at": None,
    }
    try:
        page.goto(go_url, wait_until="domcontentloaded", timeout=30000)
    except Exception:
        evidence["redirect_ok"] = False
        return evidence

    evidence["landed_url"] = page.url
    evidence["body"] = page.inner_text("body")
    evidence["rating"] = page.evaluate(_RATING_JS)
    evidence["prime"] = page.evaluate(_PRIME_JS)
    return evidence


def pace(pacing_cfg: dict) -> None:
    lo = pacing_cfg.get("min_delay_s", 12)
    hi = pacing_cfg.get("max_delay_s", 25)
    time.sleep(random.uniform(lo, hi))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_checker.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/affiliate-audit/checker.py tools/affiliate-audit/tests/test_checker.py
git commit -m "feat(affiliate-audit): add CloakBrowser-driven per-product checker"
```

---

### Task 6: `resolve.py` — resolution agent invocation

**Files:**
- Create: `tools/affiliate-audit/resolve.py`
- Test: `tools/affiliate-audit/tests/test_resolve.py`

**Interfaces:**
- Consumes: `product: dict` (from Task 1's discover shape), `evidence: dict` (Task 5),
  `verdict: str` (Task 3), `resolution_cfg: dict` (`config["resolution"]`, Task 2),
  `site_dir: Path`, `site_domain: str`.
- Produces:
  - `build_prompt(product, evidence, verdict, resolution_cfg, site_dir, site_domain) -> str`
    (pure string builder, fully unit-testable without spawning a process).
  - `resolve_product(product, evidence, verdict, resolution_cfg, site_dir, site_domain, log_path) -> int`
    (spawns `claude -p <prompt> --max-turns N --model M`, cwd=`site_dir`, returns the
    subprocess exit code; logs stdout+stderr to `log_path`). Uses `subprocess.run` so
    it's mockable via `unittest.mock.patch`.

- [ ] **Step 1: Write the failing test**

```python
# tools/affiliate-audit/tests/test_resolve.py
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import resolve  # noqa: E402

PRODUCT = {
    "id": "widget",
    "name": "Widget",
    "brand": "WidgetCo",
    "category": "hard-jerks",
    "price": "$9.99",
    "asin": "B00WIDGET1",
    "searchQuery": "widget jerkbait",
    "blurb": "The widget you need.",
    "campaignOnly": False,
}
EVIDENCE = {"go_url": "https://totaljerks.com/go/widget/", "body": "currently unavailable"}
RESOLUTION_CFG = {"max_search_attempts": 3, "max_agent_turns": 20, "model": "claude-sonnet-4-6"}


def test_build_prompt_includes_budget_and_product_facts():
    prompt = resolve.build_prompt(
        PRODUCT, EVIDENCE, "oos", RESOLUTION_CFG, Path("/tmp/site"), "totaljerks.com"
    )
    assert "widget" in prompt
    assert "hard-jerks" in prompt
    assert "3 search attempt" in prompt
    assert "oos" in prompt
    assert ".deploy-needed" in prompt
    assert "notify-slack.sh" in prompt


def test_resolve_product_invokes_claude_with_turn_cap():
    with mock.patch("resolve.subprocess.run") as mock_run:
        mock_run.return_value = mock.Mock(returncode=0, stdout="done", stderr="")
        code = resolve.resolve_product(
            PRODUCT, EVIDENCE, "oos", RESOLUTION_CFG, Path("/tmp/site"), "totaljerks.com",
            log_path=Path("/tmp/resolve-test.log"),
        )
    assert code == 0
    args = mock_run.call_args.args[0]
    assert args[0] == "claude"
    assert "--max-turns" in args
    assert "20" in args
    assert "--model" in args
    assert "claude-sonnet-4-6" in args
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_resolve.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'resolve'`

- [ ] **Step 3: Write `resolve.py`**

```python
"""Spawn a turn-capped `claude -p` resolution agent for one flagged product.
Mirrors the existing fleet pattern in ops/scripts/run-role.sh (claude -p +
--max-turns), scoped down to a single-product task instead of a full role."""
import subprocess
from pathlib import Path


def build_prompt(
    product: dict,
    evidence: dict,
    verdict: str,
    resolution_cfg: dict,
    site_dir: Path,
    site_domain: str,
) -> str:
    max_attempts = resolution_cfg.get("max_search_attempts", 3)
    return f"""You are the affiliate-audit resolution agent for {site_domain}.

One product in `site/src/lib/affiliate.ts` was flagged by the deterministic
affiliate-audit checker. Your ONLY job is to resolve this single product.

## Flagged product

- id: {product['id']}
- name: {product['name']}
- brand: {product['brand']}
- category: {product['category']}
- price: {product['price']}
- asin: {product.get('asin')}
- searchQuery: {product['searchQuery']}
- blurb (site voice, match this tone in any replacement copy): {product['blurb']}
- campaignOnly: {product.get('campaignOnly', False)}

## Verdict

{verdict} — checked URL {evidence.get('go_url')}
Evidence (landed-page body excerpt): {(evidence.get('body') or '')[:500]!r}

## Budget — hard limits, do not exceed

- At most {max_attempts} search attempts for a replacement candidate. If none
  verify, STOP — do not keep searching.
- Do not extend your own budget under any circumstance.

## If campaignOnly is true

Do NOT search for or apply a replacement — Creator Connections campaign products
are a contractual relationship, not an editorial pick. Skip straight to "Unable
to resolve" below.

## Task

1. Search Amazon for a same-category ({product['category']}) replacement in a
   similar price band to {product['price']}, matching the brand/voice implied by
   the existing blurb where reasonable.
2. For each candidate (up to {max_attempts}), verify it LIVE using the CloakBrowser
   driver (`tools/creator-connections/cc_lib.py` — `launch()`,
   `pull_product_page_info()`): confirm it is in stock, has a Prime badge, and a
   rating >= 4.0. Do not pick a candidate you have not verified this way.
3. On finding a verified candidate:
   - Edit the product's entry in `site/src/lib/affiliate.ts` in place (same `id`,
     new `name`/`brand`/`asin`/`price`/`searchQuery`/`blurb`/`amazonImageId` as
     appropriate) — do not add a new product entry or remove the slug.
   - Run `cd site && npm run build` to regenerate `public/_redirects` and confirm
     the build (including the `smoke-affiliate` postbuild check, where present)
     is green. A build/validator failure means this is NOT resolved — fall
     through to "Unable to resolve" below instead of committing.
   - `git add` only the files you intentionally changed (never `-A`/`.`).
   - Commit: `git commit -m "affiliate: replace {product['id']} (<verdict> — <new product>)"`.
   - Create `.deploy-needed` at the repo root (empty file) so the existing
     `deployer` role ships it with its own push + live-smoke-verify — do not
     `git push` yourself.
   - Post to Slack via `ops/scripts/notify-slack.sh "$SLACK_CHANNEL" "<message>"`:
     one line naming the old product, the new product, and the reason
     (verdict + evidence), prefixed with `✅`.
4. Unable to resolve (budget exhausted, no candidate verified, campaignOnly, or
   build/validator failure):
   - Leave `affiliate.ts` untouched (or revert any edit you made).
   - File `ops/tasks/backlog/<yyyy-mm-dd>-affiliate-issue-{product['id']}.md`
     with `type: content`, the verdict, the evidence, and what you tried.
   - Post to Slack via `ops/scripts/notify-slack.sh "$SLACK_CHANNEL" "<message>"`:
     one line naming the product, the verdict, and the task file path, prefixed
     with `⚠️`.

Do not touch any product other than `{product['id']}`. Do not create
`.deploy-needed` unless you made and committed a change in step 3.
"""


def resolve_product(
    product: dict,
    evidence: dict,
    verdict: str,
    resolution_cfg: dict,
    site_dir: Path,
    site_domain: str,
    log_path: Path,
) -> int:
    prompt = build_prompt(product, evidence, verdict, resolution_cfg, site_dir, site_domain)
    max_turns = str(resolution_cfg.get("max_agent_turns", 20))
    model = resolution_cfg.get("model", "claude-sonnet-4-6")

    result = subprocess.run(
        ["claude", "-p", prompt, "--max-turns", max_turns, "--model", model],
        cwd=str(site_dir),
        capture_output=True,
        text=True,
        timeout=1800,
    )
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(
        f"exit={result.returncode}\n--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}\n"
    )
    return result.returncode
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_resolve.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/affiliate-audit/resolve.py tools/affiliate-audit/tests/test_resolve.py
git commit -m "feat(affiliate-audit): add turn-capped resolution agent invocation"
```

---

### Task 7: `run.py` — orchestrator entrypoint

**Files:**
- Create: `tools/affiliate-audit/run.py`
- Test: `tools/affiliate-audit/tests/test_run.py`

**Interfaces:**
- Consumes: `config.load_config` (Task 2), `checker.launch_browser`/`check_product`/`pace`
  (Task 5), `classify.classify` (Task 3), `state.load_state`/`update_state`/`save_state`
  (Task 4), `resolve.resolve_product` (Task 6), and `discover.mjs` (Task 1, invoked via
  subprocess).
- Produces: CLI `python3 run.py --site <domain> [--dry-run]`. `--dry-run` runs
  discover→check→classify→state (state IS still written — it's the real audit trail)
  but skips `resolve.resolve_product` and instead prints what would have been
  triggered. Exit code 0 on a completed run regardless of individual product verdicts
  (non-zero only on a hard orchestration failure, e.g. discover.mjs erroring).

- [ ] **Step 1: Write the failing test**

Uses dependency injection via a `Deps` object so `run_once` never imports a real
browser/subprocess in tests.

```python
# tools/affiliate-audit/tests/test_run.py
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run  # noqa: E402

CFG = {
    "checks": {
        "prime_required": True,
        "min_rating": 4.0,
        "oos_grace_runs": 2,
        "dead_grace_runs": 1,
        "broken_redirect_grace_runs": 1,
        "no_prime_grace_runs": 2,
        "low_rating_grace_runs": 2,
    },
    "pacing": {"min_delay_s": 0, "max_delay_s": 0},
    "resolution": {"max_search_attempts": 3, "max_agent_turns": 20, "model": "claude-sonnet-4-6"},
    "slack": {"channel_env": "SLACK_CHANNEL_TOTALJERKS", "channel_default": None},
}

PRODUCTS = [
    {"id": "healthy-one", "name": "Healthy", "brand": "B", "category": "hard-jerks",
     "price": "$1", "asin": "B001", "searchQuery": "healthy", "blurb": "fine",
     "campaignOnly": False},
    {"id": "dead-one", "name": "Dead", "brand": "B", "category": "hard-jerks",
     "price": "$1", "asin": "B002", "searchQuery": "dead", "blurb": "gone",
     "campaignOnly": False},
]


def test_run_once_resolves_actionable_and_skips_healthy():
    fake_page = object()
    evidence_by_id = {
        "healthy-one": {"go_url": "x", "body": "buy now", "prime": True, "rating": 4.8, "redirect_ok": True},
        "dead-one": {"go_url": "y", "body": "Sorry! We couldn't find that page", "prime": None,
                     "rating": None, "redirect_ok": True},
    }

    with mock.patch("run.discover_products", return_value=PRODUCTS), \
         mock.patch("run.checker.launch_browser", return_value=(mock.Mock(), fake_page)), \
         mock.patch("run.checker.check_product", side_effect=lambda page, base, product, pacing: evidence_by_id[product["id"]]), \
         mock.patch("run.checker.pace"), \
         mock.patch("run.state.load_state", return_value={}), \
         mock.patch("run.state.save_state") as mock_save_state, \
         mock.patch("run.resolve.resolve_product", return_value=0) as mock_resolve, \
         mock.patch("run.notify_summary") as mock_notify:
        run.run_once(Path("/tmp/site"), "totaljerks.com", CFG, dry_run=False, today="2026-07-15")

    mock_resolve.assert_called_once()
    resolved_product = mock_resolve.call_args.args[0]
    assert resolved_product["id"] == "dead-one"
    mock_save_state.assert_called_once()
    mock_notify.assert_called_once()


def test_run_once_dry_run_never_resolves():
    fake_page = object()
    evidence_by_id = {
        "healthy-one": {"go_url": "x", "body": "buy now", "prime": True, "rating": 4.8, "redirect_ok": True},
        "dead-one": {"go_url": "y", "body": "Sorry! We couldn't find that page", "prime": None,
                     "rating": None, "redirect_ok": True},
    }

    with mock.patch("run.discover_products", return_value=PRODUCTS), \
         mock.patch("run.checker.launch_browser", return_value=(mock.Mock(), fake_page)), \
         mock.patch("run.checker.check_product", side_effect=lambda page, base, product, pacing: evidence_by_id[product["id"]]), \
         mock.patch("run.checker.pace"), \
         mock.patch("run.state.load_state", return_value={}), \
         mock.patch("run.state.save_state"), \
         mock.patch("run.resolve.resolve_product") as mock_resolve, \
         mock.patch("run.notify_summary"):
        run.run_once(Path("/tmp/site"), "totaljerks.com", CFG, dry_run=True, today="2026-07-15")

    mock_resolve.assert_not_called()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_run.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'run'`

- [ ] **Step 3: Write `run.py`**

```python
#!/usr/bin/env python3
"""Orchestrator entrypoint: discover -> check -> classify -> state -> resolve
-> notify. One entrypoint, one site per invocation.

Usage:
    python3 run.py --site totaljerks.com [--dry-run]
"""
import argparse
import json
import subprocess
import sys
from datetime import date, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import checker  # noqa: E402
import classify  # noqa: E402
import config  # noqa: E402
import resolve  # noqa: E402
import state  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]  # .../domains
AUDIT_DIR = Path(__file__).resolve().parent


def discover_products(site_dir: Path) -> list[dict]:
    affiliate_ts = site_dir / "site" / "src" / "lib" / "affiliate.ts"
    result = subprocess.run(
        ["npx", "tsx", str(AUDIT_DIR / "discover.mjs"), str(affiliate_ts)],
        cwd=str(site_dir / "site"),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"discover.mjs failed: {result.stderr}")
    return json.loads(result.stdout)


def notify_summary(site_dir: Path, site_domain: str, cfg: dict, counts: dict) -> None:
    channel_env = cfg["slack"]["channel_env"]
    channel_default = cfg["slack"].get("channel_default") or f"domain-{site_domain.split('.')[0]}-com"
    line = (
        f"\U0001f440 {site_domain} affiliate audit — {counts['healthy']} healthy, "
        f"{counts['flagged']} flagged ({counts['resolving']} sent to resolution)."
    )
    subprocess.run(
        [
            "bash",
            str(site_dir / "ops" / "scripts" / "notify-slack.sh"),
            f"${{{channel_env}:-{channel_default}}}",
            line,
        ],
        cwd=str(site_dir),
        check=False,
    )


def run_once(site_dir: Path, site_domain: str, cfg: dict, dry_run: bool, today: str | None = None) -> None:
    if today is None:
        today = date.today().isoformat()

    products = discover_products(site_dir)
    ctx, page = checker.launch_browser()

    st = state.load_state(site_dir)
    counts = {"healthy": 0, "flagged": 0, "resolving": 0}

    try:
        for i, product in enumerate(products):
            evidence = checker.check_product(page, f"https://{site_domain}", product, cfg["pacing"])
            verdict = classify.classify(evidence, cfg["checks"])
            st, actionable = state.update_state(st, product["id"], verdict, today, cfg["checks"])

            if verdict in ("ok", "inconclusive"):
                counts["healthy"] += 1
            else:
                counts["flagged"] += 1

            if actionable and not dry_run:
                counts["resolving"] += 1
                log_path = site_dir / "ops" / "logs" / f"affiliate-audit-resolve-{product['id']}-{today}.log"
                resolve.resolve_product(
                    product, evidence, verdict, cfg["resolution"], site_dir, site_domain, log_path
                )
            elif actionable and dry_run:
                counts["resolving"] += 1
                print(f"[dry-run] would resolve {product['id']} ({verdict})")

            if i < len(products) - 1:
                checker.pace(cfg["pacing"])
    finally:
        ctx.close()

    state.save_state(site_dir, st)
    notify_summary(site_dir, site_domain, cfg, counts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", required=True, help="domain, e.g. totaljerks.com")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    site_dir = ROOT / "sites" / args.site
    if not site_dir.is_dir():
        print(f"no such site dir: {site_dir}", file=sys.stderr)
        sys.exit(1)

    cfg = config.load_config(site_dir)
    run_once(site_dir, args.site, cfg, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_run.py -v`
Expected: 2 passed

- [ ] **Step 5: Run the full test suite together**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/ -v && tests/test_discover.mjs.sh`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/affiliate-audit/run.py tools/affiliate-audit/tests/test_run.py
git commit -m "feat(affiliate-audit): add discover->check->classify->resolve orchestrator"
```

---

### Task 8: Migrate totaljerks.com state file + pilot cron wiring

**Files:**
- Modify: `sites/totaljerks.com/ops/state/affiliate-oos.json` → migrate into
  `sites/totaljerks.com/ops/state/affiliate-audit.json`
- Modify: `sites/totaljerks.com/ops/docker/crontab.docker`
- Modify: `sites/totaljerks.com/ops/roles/affiliate-editor.md` (mark retired)

**Interfaces:**
- Consumes: `state.py`'s state shape (Task 4).

- [ ] **Step 1: Write the migration script inline and run it**

```bash
cd /home/jesse/projects/domains/sites/totaljerks.com
python3 - <<'EOF'
import json
from pathlib import Path

old = Path("ops/state/affiliate-oos.json")
new = Path("ops/state/affiliate-audit.json")

old_data = json.loads(old.read_text()) if old.exists() else {}
new_data = {}
for product_id, first_seen in old_data.items():
    new_data[product_id] = {
        "issue": "oos",
        "consecutive_runs": 2,  # already flagged under the old scheme -> actionable now
        "first_seen": first_seen,
        "last_checked": first_seen,
    }

new.parent.mkdir(parents=True, exist_ok=True)
new.write_text(json.dumps(new_data, indent=2, sort_keys=True) + "\n")
print(f"migrated {len(new_data)} entries")
EOF
```

Expected: `migrated 2 entries` (the current `acme-kastmaster-chrome` and
`mepps-musky-killer` OOS entries).

- [ ] **Step 2: Remove the old state file and update `crontab.docker`**

```bash
cd /home/jesse/projects/domains/sites/totaljerks.com
git rm ops/state/affiliate-oos.json
```

Edit `ops/docker/crontab.docker`: find the line
`30 8 * * 3   bash ops/scripts/run-worker.sh affiliate-editor` and replace with:

```
30 8 * * 3   cd /home/jesse/projects/domains && python3 tools/affiliate-audit/run.py --site totaljerks.com
```

Also update the comment line above it (currently
`# Affiliate-editor — Wednesdays 7am. NO-DEPLOY sentinel: curl-checks every /go/ link,`)
to:

```
# affiliate-audit — Wednesdays 7am. CloakBrowser-driven checker + turn-capped
# resolution agent (only spawned on a flagged product). See
# docs/superpowers/specs/2026-07-15-affiliate-audit-fleet-service-design.md.
```

- [ ] **Step 3: Mark the old role retired**

Edit `sites/totaljerks.com/ops/roles/affiliate-editor.md`: add at the very top,
above the `# Affiliate Editor Role` heading:

```markdown
> **RETIRED 2026-07-15.** Replaced by `tools/affiliate-audit/run.py` — see
> `docs/superpowers/specs/2026-07-15-affiliate-audit-fleet-service-design.md`.
> This file is kept for reference only; `crontab.docker` no longer invokes it.

```

- [ ] **Step 4: Commit both repos**

```bash
cd /home/jesse/projects/domains/sites/totaljerks.com
git add ops/state/affiliate-audit.json ops/docker/crontab.docker ops/roles/affiliate-editor.md
git commit -m "chore: migrate to affiliate-audit service, retire curl-based affiliate-editor cron"

cd /home/jesse/projects/domains
git add sites/totaljerks.com
git commit -m "chore: bump totaljerks.com submodule pointer (affiliate-audit migration)"
```

(If `sites/totaljerks.com` is a plain nested repo rather than a git submodule in the
`domains` superproject, skip the second commit — check `git -C sites/totaljerks.com
status` vs `git status sites/totaljerks.com` first to confirm which applies before
running either.)

---

### Task 9: End-to-end pilot verification on totaljerks.com

**Files:**
- Temporarily modify: `sites/totaljerks.com/site/src/lib/affiliate.ts` (one synthetic
  entry, reverted or resolved by the agent itself — see below)

**Interfaces:** none new — this task exercises Tasks 1–8 together against the real
site.

- [ ] **Step 1: Add a synthetic broken product**

Add one entry to `PRODUCTS` in `site/src/lib/affiliate.ts` (any category), with a
garbage ASIN that Amazon will soft-404 on, e.g.:

```typescript
{
  id: 'pilot-synthetic-broken',
  name: 'Pilot Synthetic Broken',
  brand: 'PilotCo',
  category: 'hard-jerks',
  price: '$9.99',
  asin: 'B00PILOTXXX',
  searchQuery: 'megabass vision 110 jr jerkbait',
  image: '/products/megabass-vision-110-jr.jpg',
  blurb: 'Synthetic pilot entry for affiliate-audit e2e testing — safe to auto-replace.',
},
```

Commit it directly (this is test fixture data, not a real product — do not run it
through the resolution flow's own commit path):

```bash
cd /home/jesse/projects/domains/sites/totaljerks.com
git add site/src/lib/affiliate.ts
git commit -m "test: add synthetic broken product for affiliate-audit e2e pilot"
```

- [ ] **Step 2: Run the orchestrator in dry-run mode first**

```bash
cd /home/jesse/projects/domains
python3 tools/affiliate-audit/run.py --site totaljerks.com --dry-run
```

Expected: output includes `[dry-run] would resolve pilot-synthetic-broken (dead)`
(since `dead_grace_runs` defaults to 1, it's actionable on the first run). Confirm
`sites/totaljerks.com/ops/state/affiliate-audit.json` now has a `pilot-synthetic-broken`
entry with `"issue": "dead"`.

- [ ] **Step 3: Run the orchestrator for real**

```bash
cd /home/jesse/projects/domains
python3 tools/affiliate-audit/run.py --site totaljerks.com
```

Expected: the resolution agent runs (visible in
`sites/totaljerks.com/ops/logs/affiliate-audit-resolve-pilot-synthetic-broken-<date>.log`),
and one of two outcomes lands within its turn budget:
- `affiliate.ts`'s `pilot-synthetic-broken` entry is edited to a verified real
  product, `.deploy-needed` exists at the `totaljerks.com` repo root, and a Slack
  message posted (if `SLACK_BOT_TOKEN` is set locally).
- Or: a task file exists at
  `sites/totaljerks.com/ops/tasks/backlog/<date>-affiliate-issue-pilot-synthetic-broken.md`
  and a Slack "outstanding" message posted, with `affiliate.ts` unchanged.

Either outcome is a pass for this pilot — the point is confirming the full pipeline
wires together, not forcing a specific verdict from Amazon's live catalog.

- [ ] **Step 4: Clean up the synthetic entry**

If the agent resolved it, the entry is now a real product — leave it, or replace it
with a real curated pick and remove the "Synthetic pilot entry" blurb language before
merging to keep the catalog editorial (per `CLAUDE.md`'s guardrails). If it went to
"outstanding", remove the synthetic entry and its backlog task file entirely:

```bash
cd /home/jesse/projects/domains/sites/totaljerks.com
git rm ops/tasks/backlog/<date>-affiliate-issue-pilot-synthetic-broken.md  # if present
# hand-edit site/src/lib/affiliate.ts to remove the pilot-synthetic-broken entry
git add site/src/lib/affiliate.ts
git commit -m "test: remove synthetic affiliate-audit pilot entry after e2e verification"
```

- [ ] **Step 5: Confirm `.deploy-needed` was picked up (if the agent created it)**

Run: `ls sites/totaljerks.com/.deploy-needed 2>/dev/null || echo "no pending deploy"`
If present, either let the scheduled `deployer` role pick it up on its next 15-minute
poll, or invoke it manually per `ops/roles/deployer.md` — this is the existing,
already-trusted deploy path, not new surface from this plan.

---

## Rollout to the remaining 12 sites (follow-on, not part of this plan's tasks)

Once Task 9 passes clean, repeat Task 8's wiring (state migration + crontab line +
role-retirement note) for each of: aliencouncil.com, americastrikes.com,
broadwayshowgirls.com, deeppenetrations.com, reviewtattoo.com, saveusfarms.com,
shoptopless.com, sinderella.org, ultrarough.com, weapontester.com, wetpages.com,
xxxtea.com. No code changes needed in `tools/affiliate-audit/` — it's already generic
per-site via `--site <domain>`. Each site gets its own dry-run verification (Task 9,
Steps 2 only — the synthetic-product e2e isn't needed again once the pipeline itself
is proven) before its crontab line goes live.

---

### Task 11: re-verification gate for flagged verdicts (pilot-driven addendum)

**Why:** Task 9's live pilot against totaljerks.com's real 127-product catalog found
that a single continuous CloakBrowser session — even with VPN, humanize, 12-25s
pacing, and a per-page settle delay — produces false-positive "Currently unavailable"
verdicts for a deterministic ~15% of products, increasingly as the sweep goes deeper.
Manual re-check confirmed this: `mepps-aglia-dressed` (ASIN B001444YWQ) came back
healthy (Prime, 3.9-star) on an isolated single-request check, then showed an
identically-formatted, buy-box-native "Currently unavailable. We don't know when or
if this item will be back in stock." message as the 3rd request in one session — text
indistinguishable from a genuine OOS message, so no marker-based fix in `classify.py`
can catch it. This looks like Amazon serving a soft, non-CAPTCHA block to sessions it
judges request-heavy, rather than a real inventory signal.

**Fix (Jesse's chosen direction):** any product whose first-pass verdict is
actionable (not `ok`, not `inconclusive`) gets ONE immediate re-check in a
brand-new, independently-launched browser context before it's trusted. If the
re-check comes back `ok`, the product is treated as healthy for this run (first-pass
result discarded as a session artifact). If the re-check reproduces the same or a
different actionable verdict, that verdict (and its evidence) is what state/resolution
sees — not the first pass's. This adds latency only for the flagged minority, not the
whole sweep.

**Files:**
- Modify: `tools/affiliate-audit/checker.py` — add `recheck_product`
- Modify: `tools/affiliate-audit/run.py` — wire the re-verification gate into the loop
- Test: `tools/affiliate-audit/tests/test_checker.py` — add re-check coverage
- Test: `tools/affiliate-audit/tests/test_run.py` — add re-check gating coverage

**Interfaces:**
- Produces: `checker.recheck_product(product: dict, base_url: str, pacing_cfg: dict) -> dict`
  — launches its own fresh `launch_browser()` context, runs `check_product` once,
  closes the context, returns the evidence dict. One-shot, self-contained.
- Consumes (in `run.py`): the existing `checker.check_product`/`classify.classify`
  results from the main sweep loop; only invoked when the first-pass verdict is not
  `"ok"` and not `"inconclusive"`.

- [ ] **Step 1: Write the failing test for `checker.recheck_product`**

```python
# append to tools/affiliate-audit/tests/test_checker.py

def test_recheck_product_uses_fresh_context():
    fresh_page = FakePage(url="https://amazon.com/dp/B00WIDGET1", body="Buy Widget now", rating=4.6, prime=True)
    fake_ctx = type("FakeCtx", (), {"closed": False, "close": lambda self: setattr(self, "closed", True)})()

    with mock.patch("checker.launch_browser", return_value=(fake_ctx, fresh_page)):
        ev = checker.recheck_product(PRODUCT, "https://totaljerks.com", {})

    assert ev["redirect_ok"] is True
    assert ev["body"] == "Buy Widget now"
    assert fake_ctx.closed is True
```

Add `from unittest import mock` to the top of `tools/affiliate-audit/tests/test_checker.py` if not already present.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_checker.py -v`
Expected: FAIL with `AttributeError: module 'checker' has no attribute 'recheck_product'`

- [ ] **Step 3: Add `recheck_product` to `checker.py`**

Append to `tools/affiliate-audit/checker.py`:

```python
def recheck_product(product: dict, base_url: str, pacing_cfg: dict) -> dict:
    """One-shot re-verification in a brand-new browser context. Used when a
    product's first-pass verdict was flagged, to rule out a session-level
    false positive (e.g. Amazon serving a degraded response deep into a long
    sweep) before trusting the result. Always closes its own context, even
    on failure inside check_product."""
    ctx, page = launch_browser()
    try:
        return check_product(page, base_url, product, pacing_cfg)
    finally:
        ctx.close()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_checker.py -v`
Expected: all checker tests pass (3/3)

- [ ] **Step 5: Write the failing test for the re-verification gate in `run.py`**

```python
# append to tools/affiliate-audit/tests/test_run.py

def test_run_once_recheck_confirms_flagged_verdict_stays_flagged():
    fake_page = object()
    first_pass = {
        "healthy-one": {"go_url": "x", "body": "buy now", "prime": True, "rating": 4.8, "redirect_ok": True},
        "dead-one": {"go_url": "y", "body": "Sorry! We couldn't find that page", "prime": None,
                     "rating": None, "redirect_ok": True},
    }
    # recheck confirms dead-one is still broken
    recheck_evidence = {"go_url": "y", "body": "Sorry! We couldn't find that page", "prime": None,
                         "rating": None, "redirect_ok": True}

    with mock.patch("run.discover_products", return_value=PRODUCTS), \
         mock.patch("run.checker.launch_browser", return_value=(mock.Mock(), fake_page)), \
         mock.patch("run.checker.check_product", side_effect=lambda page, base, product, pacing: first_pass[product["id"]]), \
         mock.patch("run.checker.recheck_product", return_value=recheck_evidence) as mock_recheck, \
         mock.patch("run.checker.pace"), \
         mock.patch("run.state.load_state", return_value={}), \
         mock.patch("run.state.save_state"), \
         mock.patch("run.resolve.resolve_product", return_value=0) as mock_resolve, \
         mock.patch("run.notify_summary"):
        run.run_once(Path("/tmp/site"), "totaljerks.com", CFG, dry_run=False, today="2026-07-15")

    # recheck only called for the flagged product, not the healthy one
    mock_recheck.assert_called_once()
    assert mock_recheck.call_args.args[0]["id"] == "dead-one"
    # resolution still fires, using the recheck-confirmed verdict
    mock_resolve.assert_called_once()


def test_run_once_recheck_clears_false_positive():
    fake_page = object()
    first_pass = {
        "healthy-one": {"go_url": "x", "body": "buy now", "prime": True, "rating": 4.8, "redirect_ok": True},
        "dead-one": {"go_url": "y", "body": "currently unavailable", "prime": None,
                     "rating": None, "redirect_ok": True},
    }
    # recheck comes back healthy -- first pass was a session artifact
    recheck_evidence = {"go_url": "y", "body": "buy now", "prime": True, "rating": 4.9, "redirect_ok": True}

    with mock.patch("run.discover_products", return_value=PRODUCTS), \
         mock.patch("run.checker.launch_browser", return_value=(mock.Mock(), fake_page)), \
         mock.patch("run.checker.check_product", side_effect=lambda page, base, product, pacing: first_pass[product["id"]]), \
         mock.patch("run.checker.recheck_product", return_value=recheck_evidence) as mock_recheck, \
         mock.patch("run.checker.pace"), \
         mock.patch("run.state.load_state", return_value={}), \
         mock.patch("run.state.save_state"), \
         mock.patch("run.resolve.resolve_product", return_value=0) as mock_resolve, \
         mock.patch("run.notify_summary"):
        run.run_once(Path("/tmp/site"), "totaljerks.com", CFG, dry_run=False, today="2026-07-15")

    mock_recheck.assert_called_once()
    # cleared by the recheck -- never sent to resolution
    mock_resolve.assert_not_called()
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_run.py -v`
Expected: FAIL — recheck never invoked (`AssertionError` on `mock_recheck.assert_called_once()`), since `run.py` doesn't call `checker.recheck_product` yet.

- [ ] **Step 7: Wire the re-verification gate into `run.py`**

In `run_once`, immediately after computing `verdict = classify.classify(evidence, cfg["checks"])` and before the `state.update_state(...)` call, insert:

```python
            if verdict not in ("ok", "inconclusive"):
                evidence = checker.recheck_product(product, f"https://{site_domain}", cfg["pacing"])
                verdict = classify.classify(evidence, cfg["checks"])
```

This replaces both `evidence` and `verdict` with the re-check's result before they
flow into `state.update_state`, the `counts` bookkeeping, and (if still actionable)
`resolve.resolve_product` — so a re-check "ok" result correctly counts as healthy for
this run, and a re-check that reproduces the issue carries the re-check's (fresher)
evidence forward, not the stale first-pass evidence.

- [ ] **Step 8: Run test to verify it passes**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_run.py -v`
Expected: all run.py tests pass (4/4)

- [ ] **Step 9: Run the full suite**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/ -v && tests/test_discover.mjs.sh`
Expected: all green, no regressions across every prior task's tests.

- [ ] **Step 10: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/affiliate-audit/checker.py tools/affiliate-audit/run.py tools/affiliate-audit/tests/test_checker.py tools/affiliate-audit/tests/test_run.py
git commit -m "fix(affiliate-audit): re-verify flagged verdicts in a fresh browser context before trusting them"
```

---

### Task 12: two-phase sweep to avoid concurrent Playwright sync sessions (pilot-driven addendum)

**Why:** A second live pilot run (after Task 11's profile-collision fix, commit `34ea983`) crashed with a
different, more fundamental error:

```
playwright._impl._errors.Error: It looks like you are using Playwright Sync API inside the asyncio loop.
Please use the Async API instead.
```

raised from `checker.recheck_product()` → `launch_browser(profile=RECHECK_PROFILE)` →
`cc_lib.launch(profile=...)` → `launch_persistent_context(...)` → `sync_playwright().start()`, called
while the main sweep's own `sync_playwright()` session (opened once at the top of `run_once` and not
yet closed) was still active in the same process/thread. Playwright's Sync API does not support two
concurrent sessions in one thread, regardless of using different profiles — the Task 11 profile fix
was necessary (it fixed the `pkill` cross-kill) but not sufficient (it didn't fix the deeper
same-thread concurrency limitation).

**Fix:** restructure `run_once` into two sequential phases instead of one interleaved loop:

1. **Phase 1 (main sweep):** unchanged in spirit — open one browser context, `check_product` +
   `classify` every product in the catalog, paced. But instead of acting on each verdict immediately,
   collect `(product, evidence, verdict)` tuples into a list. Close the main context when the sweep
   finishes (`finally: ctx.close()`), same as today — just before doing anything else.
2. **Phase 2 (recheck + act):** AFTER the main context is fully closed, iterate the collected list.
   For any `(product, evidence, verdict)` whose verdict is actionable (not `"ok"`, not
   `"inconclusive"`), call `checker.recheck_product(...)` (which opens+closes its own
   `RECHECK_PROFILE` context, one at a time, sequentially — never overlapping with another open
   session since Phase 1's context is already closed by this point) and reclassify. Then run the
   existing `state.update_state` / counts / `resolve.resolve_product` logic for every product
   (healthy ones included, using their Phase 1 result unchanged; only actionable ones get the
   Phase 2 recheck first).

This preserves every existing behavioral guarantee from Task 11 (recheck only fires for actionable
verdicts, recheck's result fully replaces the first pass's, dry-run still skips only
`resolve.resolve_product`) — it only changes *when* the recheck happens relative to the main sweep's
browser lifecycle, not what it does.

**Files:**
- Modify: `tools/affiliate-audit/run.py` — restructure `run_once` into two phases
- Test: `tools/affiliate-audit/tests/test_run.py` — update existing tests for the new structure

**Interfaces:** no changes to any other module's public interface (`checker.recheck_product`,
`classify.classify`, `state.update_state`, `resolve.resolve_product` all keep their existing
signatures from prior tasks).

- [ ] **Step 1: Read the current `run_once`**

Read `tools/affiliate-audit/run.py`'s current `run_once` function (post-Task-11) to see exactly
where the interleaved recheck-and-act logic sits inside the single `for` loop under `try: ... finally:
ctx.close()`.

- [ ] **Step 2: Update the existing tests in `test_run.py` for the two-phase structure**

The existing tests (`test_run_once_resolves_actionable_and_skips_healthy`,
`test_run_once_dry_run_never_resolves`, `test_run_once_recheck_confirms_flagged_verdict_stays_flagged`,
`test_run_once_recheck_clears_false_positive`) should all still pass conceptually unchanged — they
mock `run.checker.launch_browser`, `run.checker.check_product`, `run.checker.recheck_product`,
`run.checker.pace`, `run.state.*`, `run.resolve.resolve_product`, `run.notify_summary` and assert on
final outcomes (which product got resolved, whether recheck fired, whether resolve fired) — none of
these assertions depend on *when* within `run_once` the recheck happens, only that it happens for the
right products with the right result. Add ONE new test asserting the new phase separation directly:

```python
# add to tools/affiliate-audit/tests/test_run.py

def test_run_once_closes_main_context_before_any_recheck():
    """Regression test for the Playwright Sync API concurrent-session crash:
    the main sweep's browser context must be closed before recheck_product
    (which opens its own separate Playwright session) is ever called."""
    fake_page = object()
    fake_ctx = mock.Mock()
    call_order = []

    evidence_by_id = {
        "healthy-one": {"go_url": "x", "body": "buy now", "prime": True, "rating": 4.8, "redirect_ok": True},
        "dead-one": {"go_url": "y", "body": "Sorry! We couldn't find that page", "prime": None,
                     "rating": None, "redirect_ok": True},
    }
    recheck_evidence = {"go_url": "y", "body": "Sorry! We couldn't find that page", "prime": None,
                         "rating": None, "redirect_ok": True}

    def record_close():
        call_order.append("ctx.close")

    def record_recheck(product, base, pacing):
        call_order.append("recheck_product")
        return recheck_evidence

    fake_ctx.close.side_effect = record_close

    with mock.patch("run.discover_products", return_value=PRODUCTS), \
         mock.patch("run.checker.launch_browser", return_value=(fake_ctx, fake_page)), \
         mock.patch("run.checker.check_product", side_effect=lambda page, base, product, pacing: evidence_by_id[product["id"]]), \
         mock.patch("run.checker.recheck_product", side_effect=record_recheck), \
         mock.patch("run.checker.pace"), \
         mock.patch("run.state.load_state", return_value={}), \
         mock.patch("run.state.save_state"), \
         mock.patch("run.resolve.resolve_product", return_value=0), \
         mock.patch("run.notify_summary"):
        run.run_once(Path("/tmp/site"), "totaljerks.com", CFG, dry_run=False, today="2026-07-15")

    assert call_order == ["ctx.close", "recheck_product"], (
        f"main context must close before any recheck_product call, got order: {call_order}"
    )
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_run.py::test_run_once_closes_main_context_before_any_recheck -v`
Expected: FAIL — current `run_once` calls `recheck_product` inside the same `try` block, before
`ctx.close()` runs in `finally`, so `call_order` will be `["recheck_product", "ctx.close"]` (or
`recheck_product` interleaved before the close), not the required order.

- [ ] **Step 4: Restructure `run_once` into two phases**

Replace the body of `run_once` in `tools/affiliate-audit/run.py` (from `products = discover_products(...)`
through the `state.save_state` / `notify_summary` calls) with:

```python
    products = discover_products(site_dir)
    ctx, page = checker.launch_browser()

    first_pass = []
    try:
        for i, product in enumerate(products):
            evidence = checker.check_product(page, f"https://{site_domain}", product, cfg["pacing"])
            verdict = classify.classify(evidence, cfg["checks"])
            first_pass.append((product, evidence, verdict))
            if i < len(products) - 1:
                checker.pace(cfg["pacing"])
    finally:
        ctx.close()

    st = state.load_state(site_dir)
    counts = {"healthy": 0, "flagged": 0, "resolving": 0}

    for product, evidence, verdict in first_pass:
        if verdict not in ("ok", "inconclusive"):
            evidence = checker.recheck_product(product, f"https://{site_domain}", cfg["pacing"])
            verdict = classify.classify(evidence, cfg["checks"])

        st, actionable = state.update_state(st, product["id"], verdict, today, cfg["checks"])

        if verdict in ("ok", "inconclusive"):
            counts["healthy"] += 1
        else:
            counts["flagged"] += 1

        if actionable and not dry_run:
            counts["resolving"] += 1
            log_path = site_dir / "ops" / "logs" / f"affiliate-audit-resolve-{product['id']}-{today}.log"
            resolve.resolve_product(
                product, evidence, verdict, cfg["resolution"], site_dir, site_domain, log_path
            )
        elif actionable and dry_run:
            counts["resolving"] += 1
            print(f"[dry-run] would resolve {product['id']} ({verdict})")

    state.save_state(site_dir, st)
    notify_summary(site_dir, site_domain, cfg, counts)
```

Do not change `discover_products`, `notify_summary`, `main`, or any import — only `run_once`'s body
from `products = discover_products(site_dir)` onward.

- [ ] **Step 5: Run the new test to verify it passes**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_run.py::test_run_once_closes_main_context_before_any_recheck -v`
Expected: PASS

- [ ] **Step 6: Run the full `test_run.py` file to confirm no regressions in the existing 4 tests**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/test_run.py -v`
Expected: 5/5 pass (4 existing + 1 new)

- [ ] **Step 7: Run the full suite**

Run: `cd tools/affiliate-audit && python3 -m pytest tests/ -v && tests/test_discover.mjs.sh`
Expected: all green, no regressions across any prior task's tests.

- [ ] **Step 8: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/affiliate-audit/run.py tools/affiliate-audit/tests/test_run.py
git commit -m "fix(affiliate-audit): restructure run_once into two phases to avoid concurrent Playwright sync sessions"
```
