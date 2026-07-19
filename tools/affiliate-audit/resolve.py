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
