"""Spawn a turn-capped `claude -p` resolution agent for one flagged product.
Mirrors the existing fleet pattern in ops/scripts/run-role.sh (claude -p +
--max-turns), scoped down to a single-product task instead of a full role."""
import subprocess
from pathlib import Path


def file_persistent_inconclusive(
    product: dict,
    evidence: dict,
    checks_cfg: dict,
    site_dir: Path,
    today: str,
) -> Path:
    """Deterministic escalation for a product stuck on 'inconclusive' (anti-bot
    wall or repeated Amazon-side error) for N consecutive weekly runs. No LLM
    involved — there's no replacement decision to make here, just a signal
    that the checker can't get a clean read and a human should look instead
    of this silently resetting every week forever."""
    grace = checks_cfg.get("inconclusive_grace_runs", 3)
    status = evidence.get("status")
    detail = f"HTTP {status} from Amazon" if status else "anti-bot wall (captcha/Robot Check)"
    task_path = (
        site_dir / "ops" / "tasks" / "backlog" / f"{today}-affiliate-inconclusive-{product['id']}.md"
    )
    task_path.parent.mkdir(parents=True, exist_ok=True)
    task_path.write_text(
        f"""---
type: engineering
---

# Persistent inconclusive: {product['id']}

`{evidence.get('go_url')}` has been classified inconclusive ({detail}) for
{grace} consecutive weekly affiliate-audit runs. This is NOT a confirmed dead
link or de-listing — the checker cannot get a clean read on the Amazon landing
page (anti-bot wall or repeated server-side error), so no automatic replacement
was attempted. A human should check this link manually before assuming it's
actually broken.

- id: `{product['id']}`
- asin: `{product.get('asin')}`
- go_url: {evidence.get('go_url')}
- last evidence body excerpt: {(evidence.get('body') or '')[:300]!r}
"""
    )
    return task_path


def file_fallback_unresolved(
    product: dict,
    evidence: dict,
    verdict: str,
    site_dir: Path,
    today: str,
) -> Path:
    """Deterministic (no LLM) fallback for when resolve_product()'s agent
    fails to complete — hits its turn cap, crashes, or otherwise exits
    non-zero before reaching its own step-4 "file a task and commit" path.
    Without this, a flagged product silently vanishes: no task, no commit,
    no Slack line, nothing to show it needs a human. Idempotent — if the
    agent DID manage to write the task file before getting cut off (just
    not commit it), this leaves that file alone rather than overwriting it;
    the caller is responsible for committing whatever exists at this path."""
    task_path = site_dir / "ops" / "tasks" / "backlog" / f"{today}-affiliate-issue-{product['id']}.md"
    if task_path.exists():
        return task_path
    task_path.parent.mkdir(parents=True, exist_ok=True)
    task_path.write_text(
        f"""---
type: content
---

# Unresolved affiliate flag: {product['id']}

The resolution agent for this product did not complete (crashed, hit its
turn cap, or otherwise exited abnormally before filing its own task). Filed
automatically as a fallback so this doesn't silently vanish — a human should
verify the underlying issue and either replace the product or clear it.

- id: `{product['id']}`
- asin: `{product.get('asin')}`
- verdict: {verdict}
- go_url: {evidence.get('go_url')}
- evidence body excerpt: {(evidence.get('body') or '')[:300]!r}
"""
    )
    return task_path


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

- At most {max_attempts} search attempt{'s' if max_attempts != 1 else ''} for a
  replacement candidate. If none verify, STOP — do not keep searching, and do
  not treat "no confident replacement found" as a failure to work around —
  it's a normal outcome. Go straight to "Unable to resolve" below.
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
     one line naming the old product, the new product, the reason (verdict +
     evidence), and the go_url ({evidence.get('go_url')}), prefixed with `✅`.
4. Unable to resolve (budget exhausted, no candidate verified, campaignOnly, or
   build/validator failure):
   - Leave `affiliate.ts` untouched (or revert any edit you made).
   - File `ops/tasks/backlog/<yyyy-mm-dd>-affiliate-issue-{product['id']}.md`
     with `type: content`, the verdict, the evidence, and what you tried.
   - `git add` only the task file, commit
     (`affiliate: flag unresolved {product['id']} (<verdict>)`), and push —
     filing a task is not a deploy, but it must still land in the repo instead
     of sitting uncommitted in the working tree.
   - Post to Slack via `ops/scripts/notify-slack.sh "$SLACK_CHANNEL" "<message>"`:
     one line naming the product, the verdict, the go_url
     ({evidence.get('go_url')}), and the task file path, prefixed with `⚠️`.

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
        ["claude", "-p", prompt, "--max-turns", max_turns, "--model", model,
         "--dangerously-skip-permissions"],
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
