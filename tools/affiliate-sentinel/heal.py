"""The ONLY path in the sentinel that spends AI tokens.

Reached exclusively when the programmatic phase has already produced a
`CONFIRMED_DEAD` ASIN — API-missing, independently HTTP-confirmed dead, and
seen dead on two consecutive runs. On a healthy fleet this module never
executes, which is the entire point of the redesign: the predecessor spent a
full Claude session per site per week to conclude "everything is fine",
measured at $1.18 for one run.

Division of labour inside the heal, which matters because the model is being
handed write access to a live site:

  * **Deterministic (code):** finding candidates, confirming they are real and
    in stock, downloading the image, editing the registry, running the build
    gate, committing, queueing the deploy.
  * **Judgment (model):** which of several verified-real candidates actually
    fits this brand, and the on-brand copy for it.

The model never supplies an ASIN of its own — it *chooses an index* from a
list the API already verified. A hallucinated ASIN therefore cannot reach
`affiliate.ts`, which is the single most important guardrail here: everything
the model returns is either validated against the candidate set or discarded.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import registry as registry_mod

MAX_HEALS_PER_RUN = 3  # a run that wants to swap more than this is a systemic problem, not link rot

# Must NOT be cc_lib's default profile dir: launch() pkill -9's anything bound to
# the profile it is opening, so sharing one would let a sentinel run kill another
# tool's browser mid-flight (the same trap tools/affiliate-audit documents).
_SENTINEL_PROFILE = "/tmp/cloak-driver/sentinel-profile"


@dataclass
class HealResult:
    product_id: str
    dead_asin: str
    healed: bool
    new_asin: str | None = None
    new_title: str | None = None
    reason: str = ""
    unverified: list = None  # registry fields we could not source real values for

    def __post_init__(self):
        if self.unverified is None:
            self.unverified = []


def _claude_bin(site_root: Path) -> str | None:
    for c in (
        site_root / ".monorepo-tools" / "scripts" / "claude-tracked.sh",
        site_root.parents[1] / "tools" / "scripts" / "claude-tracked.sh",
    ):
        if c.is_file() and os.access(c, os.X_OK):
            return str(c)
    return None


def _browser_candidates(keywords: str, exclude: set[str], limit: int = 8) -> list[str]:
    """CloakBrowser fallback: scrape ASINs off an Amazon search page.

    Only reached when `searchItems` returns nothing usable — rare, since the
    Creators API search was confirmed working. Deliberately returns *only
    ASINs*, never product data: everything it finds is then re-verified
    through `getItems`, so a scrape that picks up a sponsored tile or a
    parent SKU cannot inject unverified data into the registry.
    """
    for p in (
        Path(__file__).resolve().parents[1] / "creator-connections",
        Path("/work/.monorepo-tools/creator-connections"),
    ):
        if p.is_dir() and str(p) not in sys.path:
            sys.path.insert(0, str(p))
    try:
        import cc_lib  # noqa: F401
    except ImportError:
        return []

    from urllib.parse import quote_plus

    try:
        ctx, page = cc_lib.launch(profile=_SENTINEL_PROFILE, headless=True)
    except Exception:
        return []
    try:
        page.goto(f"https://www.amazon.com/s?k={quote_plus(keywords)}", timeout=45000)
        asins = page.eval_on_selector_all(
            'div[data-component-type="s-search-result"]',
            "els => els.map(e => e.getAttribute('data-asin')).filter(Boolean)",
        )
    except Exception:
        return []
    finally:
        try:
            ctx.close()
        except Exception:
            pass

    out: list[str] = []
    for a in asins:
        if re.fullmatch(r"[A-Z0-9]{10}", a or "") and a not in exclude and a not in out:
            out.append(a)
        if len(out) >= limit:
            break
    return out


_RATING_JS = """
() => {
  const el = document.querySelector('#acrPopover, [data-hook="rating-out-of-text"], .a-icon-alt');
  if (!el) return null;
  const t = el.getAttribute('title') || el.textContent || '';
  const m = t.match(/([\\d.]+)\\s*out of/i);
  return m ? parseFloat(m[1]) : null;
}
"""

_REVIEWS_JS = """
() => {
  const el = document.querySelector('#acrCustomerReviewText, [data-hook="total-review-count"]');
  if (!el) return null;
  const m = (el.textContent || '').replace(/,/g, '').match(/(\\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
"""


def scrape_rating_and_reviews(asin: str, log) -> tuple[float | None, int | None]:
    """Pull rating + review count off the product page.

    The Creators API accepts `customerReviews.starRating`/`.count` as resources
    but returns them EMPTY for this account — which is worse than a rejection,
    because it reads as "this product has no reviews". Without these, every heal
    would leave the DEAD product's rating sitting under a new product's name (a
    fabricated number on a live page) and file a task asking a human to go and
    look it up. Scraping is the only way to make an auto-heal actually finish.

    Returns (None, None) on any failure; the caller then flags the fields as
    unverified rather than inventing them.
    """
    for p in (
        Path(__file__).resolve().parents[1] / "creator-connections",
        Path("/work/.monorepo-tools/creator-connections"),
    ):
        if p.is_dir() and str(p) not in sys.path:
            sys.path.insert(0, str(p))
    try:
        import cc_lib
    except ImportError:
        log("heal: cc_lib unavailable — cannot source rating/reviews")
        return None, None

    ctx = None
    try:
        # launch() returns (ctx, page) — not a single context.
        ctx, page = cc_lib.launch(profile=_SENTINEL_PROFILE, headless=True)
        page.goto(f"https://www.amazon.com/dp/{asin}", timeout=45000)
        rating = page.evaluate(_RATING_JS)
        reviews = page.evaluate(_REVIEWS_JS)
    except Exception as exc:
        log(f"heal: rating/review scrape failed ({type(exc).__name__}) — will flag as unverified")
        return None, None
    finally:
        if ctx is not None:
            try:
                ctx.close()
            except Exception:
                pass

    # A rating outside 1-5 means we matched the wrong element; do not ship it.
    if rating is not None and not (0 < float(rating) <= 5):
        log(f"heal: scraped rating {rating} is out of range — discarding")
        rating = None
    if reviews is not None and int(reviews) < 0:
        reviews = None
    log(f"heal: scraped rating={rating} reviews={reviews} for {asin}")
    return rating, reviews


def _prompt(product, dead_asin: str, candidates, site_brand: str) -> str:
    lines = [
        f"You are the Affiliate Sentinel for {site_brand}.",
        "",
        f"The product `{product.id}` in site/src/lib/affiliate.ts is DEAD: ASIN {dead_asin} "
        "is gone from the Amazon catalog. This was confirmed by the Creators API and by an "
        "independent direct fetch of its product page, on two consecutive daily runs.",
        "",
        "Current registry entry (verbatim):",
        "```ts",
        product.text,
        "```",
        "",
        "Verified replacement candidates. Every one of these was returned by the Amazon "
        "Creators API just now and confirmed IN STOCK — you do not need to check them:",
    ]
    for i, c in enumerate(candidates):
        lines.append(
            f"  [{i}] asin={c.asin} | {c.title} | brand={c.brand} | price={c.price} "
            f"| rating={c.rating} | reviews={c.review_count}"
        )
    lines += [
        "",
        "Pick the candidate that best replaces the dead product for THIS brand: same job for "
        "the reader, comparable quality tier, and something the existing copy on the site can "
        "honestly stand behind. Judge fit — do not just take the highest rating.",
        "",
        "Respond with ONE JSON object and nothing else:",
        "",
        "{",
        '  "choice": <integer index from the list above, or null if none is an acceptable fit>,',
        '  "name": "<short product name for the card, no brand prefix>",',
        '  "brand": "<brand>",',
        '  "blurb": "<one or two sentences in this site\'s established voice — match the tone of '
        'the blurb in the entry above>",',
        '  "pros": ["<short>", "<short>", "<short>"],',
        '  "cons": ["<short>", "<short>"],',
        '  "reason": "<one sentence: why this candidate, or why none fit>"',
        "}",
        "",
        'If no candidate is an honest fit, return "choice": null. That is a perfectly good '
        "answer and files a task for a human instead — never stretch to justify a bad match, "
        "because whatever you pick goes live on the site.",
    ]
    return "\n".join(lines)


def _ask_model(site_root: Path, prompt: str, model: str, log) -> dict | None:
    claude = _claude_bin(site_root)
    if not claude:
        log("heal: claude-tracked.sh not found — cannot run the judgment step")
        return None

    # claude-tracked.sh hard-requires BOTH of these and exits 64 without them;
    # they are what lands this spend in the Fleet Dashboard AI Usage tab
    # attributed to the right site and role, which is the only way anyone will
    # ever notice if healing starts firing more often than link rot justifies.
    env = dict(os.environ, CRON_ROLE="affiliate-sentinel", CRON_SITE=site_root.name)
    try:
        r = subprocess.run(
            [claude, prompt, "--model", model],
            cwd=str(site_root),
            capture_output=True,
            text=True,
            timeout=600,
            env=env,
        )
    except subprocess.TimeoutExpired:
        log("heal: model call timed out after 600s")
        return None

    if r.returncode != 0:
        log(f"heal: model call failed rc={r.returncode}: {r.stderr[-400:]}")
        return None

    out = r.stdout.strip()
    m = re.search(r"\{.*\}", out, re.S)
    if not m:
        log(f"heal: model returned no JSON object: {out[:300]}")
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError as exc:
        log(f"heal: model JSON did not parse: {exc}")
        return None


def _download_image(url: str, dest: Path, log) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "affiliate-sentinel/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
    except Exception as exc:
        log(f"heal: image download failed ({exc}) — keeping the existing image file")
        return False
    if len(data) < 2048:
        log("heal: image download suspiciously small — keeping the existing image file")
        return False
    # Guard against the regression this check was added for: an API thumbnail
    # silently overwrote a 78KB product hero with a 5KB one. A replacement
    # image that is a fraction of the size of what it replaces is a downgrade,
    # and a wrong-but-pretty card beats a right-but-tiny one for nobody.
    if dest.is_file():
        existing = dest.stat().st_size
        if existing and len(data) < existing * 0.5:
            log(
                f"heal: new image is {len(data)}B vs existing {existing}B "
                "— refusing to downgrade the product hero, keeping the old file"
            )
            return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return True


def update_redirects(site_root: Path, product_id: str, old_asin: str, new_asin: str, log) -> Path | None:
    """Point the static `_redirects` cloak at the new ASIN.

    Easy to miss and silently fatal: on sites that cloak via `_redirects` (as
    opposed to a `[id].astro` interstitial generated from the registry), the
    redirect target is a hardcoded second copy of the ASIN. Swapping only
    `affiliate.ts` would leave every visitor still being sent to the dead
    product — a "successful" heal that fixes nothing a user can see. Sites
    using the generated interstitial have no `_redirects` and no-op here.
    """
    path = site_root / "site" / "public" / "_redirects"
    if not path.is_file():
        return None
    text = path.read_text(encoding="utf-8")
    if old_asin not in text:
        return None

    out_lines = []
    touched = 0
    prefix_re = re.compile(rf"^\s*/[a-z0-9-]+/{re.escape(product_id)}/?\s")
    for line in text.splitlines(keepends=True):
        if prefix_re.match(line) and old_asin in line:
            line = line.replace(old_asin, new_asin)
            touched += 1
        out_lines.append(line)

    if not touched:
        log(f"heal: _redirects has no {product_id} line carrying {old_asin} — left untouched")
        return None
    path.write_text("".join(out_lines), encoding="utf-8")
    log(f"heal: rewrote {touched} _redirects line(s) for {product_id} -> {new_asin}")
    return path


def build_gate(site_root: Path, log) -> bool:
    """Run the site's real build. A heal that does not build never reaches the site."""
    site_dir = site_root / "site"
    if not (site_dir / "package.json").is_file():
        log("heal: no site/package.json — skipping build gate")
        return True
    env = dict(os.environ)
    # Astro + the Cloudflare adapter prerender step resolves DNS v6-first in
    # these containers and hangs; this is the fleet-wide fix.
    env["NODE_OPTIONS"] = (env.get("NODE_OPTIONS", "") + " --dns-result-order=ipv4first").strip()
    try:
        r = subprocess.run(
            ["npm", "run", "build"],
            cwd=str(site_dir),
            capture_output=True,
            text=True,
            timeout=1800,
            env=env,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        log(f"heal: build gate could not run ({exc}) — treating as FAILED")
        return False
    if r.returncode != 0:
        log(f"heal: BUILD GATE FAILED rc={r.returncode}\n{(r.stdout + r.stderr)[-2000:]}")
        return False
    return True


def heal_product(
    *,
    site_root: Path,
    registry_path: Path,
    product,
    dead_asin: str,
    cl,
    site_brand: str,
    model: str,
    dry_run: bool,
    log,
) -> HealResult:
    import amz

    seed = product.search_seed()
    log(f"heal: sourcing replacements for '{product.id}' via searchItems: {seed!r}")
    candidates = amz.search_replacements(cl, seed, exclude={dead_asin})

    if not candidates:
        log("heal: searchItems returned nothing usable — falling back to CloakBrowser search")
        asins = _browser_candidates(seed, exclude={dead_asin})
        if asins:
            verified = amz.check_health(cl, asins)
            candidates = [h for h in verified.values() if h.status == amz.OK]

    if not candidates:
        return HealResult(product.id, dead_asin, False, reason="no in-stock candidates found")

    if dry_run:
        return HealResult(
            product.id, dead_asin, False,
            reason=f"dry-run: {len(candidates)} candidates, top={candidates[0].asin}",
        )

    decision = _ask_model(site_root, _prompt(product, dead_asin, candidates, site_brand), model, log)
    if not decision:
        return HealResult(product.id, dead_asin, False, reason="model step failed")

    choice = decision.get("choice")
    if choice is None:
        return HealResult(
            product.id, dead_asin, False,
            reason=f"model rejected all candidates: {decision.get('reason', 'no reason given')}",
        )
    # `isinstance(True, int)` is True in Python, so a bare `"choice": true`
    # would sail through as index 1 and silently pick the second candidate.
    if isinstance(choice, bool) or not isinstance(choice, int) or not (0 <= choice < len(candidates)):
        # The model is only ever allowed to return an index into a list the API
        # verified; anything else is discarded rather than second-guessed.
        return HealResult(product.id, dead_asin, False, reason=f"model returned invalid choice {choice!r}")

    chosen = candidates[choice]

    # Re-verify immediately before writing. The search response could be
    # seconds-to-minutes stale, and the whole failure mode being fixed here is
    # "a product that looked fine wasn't".
    recheck = amz.check_health(cl, [chosen.asin]).get(chosen.asin)
    if not recheck or recheck.status != amz.OK:
        status = recheck.status if recheck else "no response"
        return HealResult(product.id, dead_asin, False, reason=f"chosen ASIN re-check failed ({status})")

    # The API cannot supply these; scrape them rather than ship the dead
    # product's numbers under a new product's name.
    rating, reviews = recheck.rating, recheck.review_count
    if rating is None or reviews is None:
        scraped_rating, scraped_reviews = scrape_rating_and_reviews(chosen.asin, log)
        rating = rating if rating is not None else scraped_rating
        reviews = reviews if reviews is not None else scraped_reviews

    updates: dict = {"asin": chosen.asin}
    for key, value in (
        ("name", decision.get("name")),
        ("brand", decision.get("brand") or chosen.brand),
        ("price", recheck.price),
        ("blurb", decision.get("blurb")),
        ("rating", rating),
        ("reviewCount", reviews),
        ("pros", decision.get("pros")),
        ("cons", decision.get("cons")),
        ("searchQuery", decision.get("name") and f"{decision.get('brand') or ''} {decision['name']}".strip()),
    ):
        if value:
            updates[key] = value

    # Anything the API could not give us a real value for, but which the entry
    # already displays, would otherwise keep the DEAD product's number sitting
    # under a new product's name — a fabricated rating on a live page, which is
    # a hard fleet rule against. Flag it loudly and let a human correct it; the
    # link itself is still fixed, which is the urgent half.
    unverified = [
        k
        for k in ("price", "rating", "reviewCount")
        if k not in updates and re.search(rf"\b{k}:\s*", product.text)
    ]
    if unverified:
        log(
            f"heal: could not verify {', '.join(unverified)} from the API — "
            f"these still show the previous product's values and need a human"
        )

    skipped = registry_mod.unknown_keys(product, updates)
    if skipped:
        log(f"heal: registry entry has no {', '.join(skipped)} field(s) — leaving them alone")

    new_text = registry_mod.apply_updates(registry_path, product, updates)
    original = registry_path.read_text(encoding="utf-8")
    registry_path.write_text(new_text, encoding="utf-8")

    redirects_path = site_root / "site" / "public" / "_redirects"
    redirects_original = (
        redirects_path.read_text(encoding="utf-8") if redirects_path.is_file() else None
    )
    update_redirects(site_root, product.id, dead_asin, chosen.asin, log)

    image_rel = product.image
    image_written: Path | None = None
    if image_rel and recheck.image_url:
        # Registry `image` paths are site-absolute (`/products/x.jpg`) and served
        # out of site/public.
        dest = site_root / "site" / "public" / image_rel.lstrip("/")
        if _download_image(recheck.image_url, dest, log):
            image_written = dest

    if not build_gate(site_root, log):
        registry_path.write_text(original, encoding="utf-8")
        if redirects_original is not None:
            redirects_path.write_text(redirects_original, encoding="utf-8")
        if image_written:
            subprocess.run(["git", "checkout", "--", str(image_written)], cwd=str(site_root), check=False)
        return HealResult(
            product.id, dead_asin, False,
            reason="build gate failed — registry reverted, nothing shipped",
        )

    return HealResult(
        product.id, dead_asin, True,
        new_asin=chosen.asin,
        new_title=decision.get("name") or chosen.title,
        reason=decision.get("reason", ""),
        unverified=unverified,
    )
