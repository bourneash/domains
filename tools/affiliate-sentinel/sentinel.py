#!/usr/bin/env python3
"""affiliate-sentinel — API-driven affiliate health check for the domain fleet.

Replaces the weekly curl-and-grep sweep with two deterministic checks that
answer two genuinely different questions:

  1. **Is the product still real?**  Amazon Creators API `getItems`, gated by an
     independent HTTP confirmation and a consecutive-run streak. The API cannot
     be blocked by a captcha, which removes the entire "inconclusive anti-bot
     wall" class the curl sweep spent most of its output on.
  2. **Does our own cloak still work?**  A direct fetch of `/go/<id>` on the live
     site, asserting the redirect target. The API cannot answer this — and this
     is where the fleet's worst affiliate bug lived (`_redirects` 404ing on
     Workers while every ASIN behind it was perfectly healthy).

Neither check costs a token. AI is invoked only when check 1 produces a
CONFIRMED_DEAD ASIN, and then only to choose among candidates the API has
already verified (see heal.py).

Everything is discovered per-run from the site itself — the registry and the
cloak routes — so products added later are picked up with no configuration
and nothing to keep in sync.

Usage:
    sentinel.py --site-root /work [--dry-run] [--no-heal] [--json]

Exit codes:
    0  ran, reported whatever it found in the site's own Slack channel.
    3  INFRASTRUCTURE failure — nothing was checked (see run-fleet.sh).
    4  ran, but the ONLY finding was the Amazon API being unavailable. The
       per-site post is suppressed and run-fleet.sh reports every affected
       site in one fleet-ops line instead. See the report section for why.
A sentinel that fails a cron tick over a dead ASIN is a sentinel someone has to
babysit; real findings surface as Slack + task files, not as an exit code.
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import amz  # noqa: E402
import cloak  # noqa: E402
import discover  # noqa: E402
import heal as heal_mod  # noqa: E402
import notify  # noqa: E402
import registry as registry_mod  # noqa: E402
import state as state_mod  # noqa: E402

DEFAULT_MODEL = "claude-sonnet-4-6"
MAX_CLOAK_CHECKS = 200  # per run; larger catalogs rotate (see --max-cloak-checks)
CONFIRM_RUNS = 2


def _log_factory(log_path: Path):
    log_path.parent.mkdir(parents=True, exist_ok=True)
    fh = log_path.open("a", encoding="utf-8")

    def log(msg: str) -> None:
        line = f"[{datetime.datetime.now().isoformat(timespec='seconds')}] {msg}"
        print(line, flush=True)
        fh.write(line + "\n")
        fh.flush()

    return log


def detect_base_url(site_root: Path) -> str | None:
    """Resolve the canonical site URL, with no per-site constant to drift.

    Three tiers, because the fleet is not uniform:
      1. a literal `site: 'https://...'` in astro.config
      2. `site: SITE_URL` pointing at a const declared in the same file — the
         common Astro idiom, and reading only tier 1 silently skipped the whole
         cloak check on those sites with a bland "no base_url detected"
      3. the directory name, which IS the domain by fleet convention. Needed at
         all because several sites (0xroulette, trainingsharks) are Vite/React
         SPAs with no astro.config to read.
    """
    for name in ("astro.config.mjs", "astro.config.ts", "astro.config.js"):
        p = site_root / "site" / name
        if not p.is_file():
            continue
        text = p.read_text(encoding="utf-8")
        m = re.search(r"\bsite:\s*['\"](https?://[^'\"]+)['\"]", text)
        if m:
            return m.group(1).rstrip("/")
        m = re.search(r"\bsite:\s*([A-Za-z_$][\w$]*)", text)
        if m:
            const = re.search(
                rf"\b{re.escape(m.group(1))}\s*=\s*['\"](https?://[^'\"]+)['\"]", text
            )
            if const:
                return const.group(1).rstrip("/")

    if "." in site_root.name:
        return f"https://{site_root.name}"
    return None


def detect_tag(site_root: Path, registry_path: Path | None) -> str | None:
    """Find the Associates tag, which does not always live with the products.

    A split or collection-backed catalog carries only ids and search phrases;
    the tag stays in `lib/affiliate.ts` next to the URL builder. Looking only
    where the products are finds nothing, and every cloak is then checked
    against a tag of `None` — which passes vacuously.
    """
    for path in (
        site_root / "site" / "src" / "lib" / "affiliate.ts",
        site_root / "site" / "src" / "data" / "affiliate.ts",
        registry_path,
    ):
        tag = _tag_in(path) if path is not None else None
        if tag:
            return tag
    return None


def _tag_in(registry_path: Path) -> str | None:
    if not registry_path.is_file():
        return None
    text = registry_path.read_text(encoding="utf-8")
    for rx in (
        r"AMAZON_TAG[^=]*=\s*(?:[^;]*?\|\|\s*)?['\"]([a-z0-9-]+-\d{2})['\"]",
        r"tag=([a-z0-9-]+-\d{2})",
    ):
        m = re.search(rx, text)
        if m:
            return m.group(1)
    # Last resort: any `'word-NN'` string. That shape is not unique to an
    # Associates tag — allthingsmasonic's catalog.ts declares price bands
    # (`'under-25'`), and reading one as the tag made every one of its 429
    # cloaks fail with "redirect target is missing the affiliate tag". Only
    # trust it in a file that is demonstrably about Amazon links.
    if re.search(r"amazon\.com|amzn\.to", text):
        m = re.search(r"['\"]([a-z0-9-]+-\d{2})['\"]", text)
        if m:
            return m.group(1)
    return None


def file_task(site_root: Path, slug: str, task_type: str, title: str, body: str, log) -> Path | None:
    today = datetime.date.today().isoformat()
    d = site_root / "ops" / "tasks" / "backlog"
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{today}-{slug}.md"
    if path.exists():
        return None
    # Don't re-file something already on the board under a different date.
    for sub in ("backlog", "in-progress"):
        dd = site_root / "ops" / "tasks" / sub
        if dd.is_dir():
            for f in dd.glob(f"*-{slug}.md"):
                log(f"task: {f.name} already open — not re-filing")
                return None
    path.write_text(
        f"---\ntype: {task_type}\ncreated: {today}\nsource: affiliate-sentinel\n---\n\n"
        f"# {title}\n\n{body}\n",
        encoding="utf-8",
    )
    return path


def write_outage_marker(site_root: Path, today: str, n_asins: int, reason: str | None) -> None:
    """Hand run-fleet.sh the numbers for its single fleet-wide outage line.

    A file rather than stdout because the cron wrapper's output is already
    redirected wholesale into the shared sweep log. It is always written OR
    removed, never left behind: a marker from a past run would silently inflate
    a later digest, which is the same class of lie as a stale green check.
    """
    path = site_root / "ops" / "logs" / ".affiliate-sentinel-api-outage"
    if reason is None:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{today}\t{n_asins}\t{reason}\n", encoding="utf-8")


def git(args: list[str], cwd: Path) -> bool:
    r = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)
    return r.returncode == 0


def _describe_sources(site_root: Path, sources: set, fallback) -> str:
    """A one-line description of where the products came from.

    Collapses per-product files to their directory: a content-collection site
    has one source file PER PRODUCT, and listing all 429 of them turned both
    the log line and the Slack alert into a wall of paths.
    """
    from collections import Counter

    if not sources:
        return ", ".join(str(p.relative_to(site_root)) for p in fallback if p is not None)
    counts = Counter(p.parent for p in sources)
    parts: list[str] = []
    for parent, n in sorted(counts.items()):
        rel = parent.relative_to(site_root)
        if n > 3:
            parts.append(f"{rel}/ ({n} files)")
        else:
            parts.extend(
                sorted(str(p.relative_to(site_root)) for p in sources if p.parent == parent)
            )
    return ", ".join(parts)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site-root", default=".", help="site repo root (contains ops/ and site/)")
    ap.add_argument("--base-url", default=None, help="override; normally read from astro.config")
    ap.add_argument("--site-brand", default=None)
    ap.add_argument("--slack-channel", default=None)
    ap.add_argument("--tag", default=None, help="override; normally read from affiliate.ts")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--confirm-runs", type=int, default=CONFIRM_RUNS)
    ap.add_argument(
        "--max-cloak-checks",
        type=int,
        default=MAX_CLOAK_CHECKS,
        help="cloak routes to probe per run (0 = all); larger catalogs rotate across runs",
    )
    ap.add_argument("--dry-run", action="store_true", help="check and report; never write, heal, or deploy")
    ap.add_argument("--no-heal", action="store_true", help="file tasks instead of auto-replacing (zero AI)")
    ap.add_argument("--json", action="store_true", help="dump the full result object to stdout")
    ap.add_argument(
        "--post-api-outage",
        action="store_true",
        help="post the per-site Slack line even when an API outage is the only finding "
             "(default: suppress it; run-fleet.sh digests the fleet in one message)",
    )
    args = ap.parse_args()

    site_root = Path(args.site_root).resolve()
    domains_root = site_root.parents[1] if len(site_root.parents) >= 2 else site_root
    site_name = site_root.name
    brand = args.site_brand or site_name
    today = datetime.date.today().isoformat()
    log = _log_factory(site_root / "ops" / "logs" / f"affiliate-sentinel-{today}.log")
    log(f"=== affiliate-sentinel {site_name} (dry_run={args.dry_run} heal={not args.no_heal}) ===")

    registry_path = registry_mod.find_registry(site_root)
    collection_dir = registry_mod.find_collection(site_root)
    if registry_path is None and collection_dir is None:
        # No registry does NOT mean nothing to check. rc-9 routes `/go/` from
        # its worker with no registry file anywhere, and the old early return
        # reported "nothing to check" and exited 0 — a live outbound link the
        # sentinel had quietly stopped looking at. The cloak check needs ids
        # and a tag, neither of which comes from the registry, so run it.
        if not discover.has_cloak(site_root, discover.detect_go_prefix(site_root)):
            log("no affiliate registry and no /go/ routes — nothing to check")
            return 0
        log("no affiliate registry found under site/src — cloak-only run")

    products = registry_mod.parse_all(site_root, registry_path)
    # Name every file the products actually came from: a split catalog has no
    # single registry path, and naming one of three files understates what was
    # (or was not) checked.
    where = _describe_sources(
        site_root,
        {p.source for p in products if p.source},
        (registry_path, collection_dir),
    )
    log(f"registry: {where}")

    # A registry file that exists but parses to nothing is a PARSER failure, not
    # a site with no products. It has happened twice for real: 0xroulette's
    # double-quoted entries, and a site whose registry was a computed
    # `products.map(...)` projection this static parser cannot evaluate. Both
    # times the run reported a cheerful "0/0 ASINs live, 0 cloaks OK" and exited
    # 0 — the most dangerous possible output, because it looks like a pass.
    # Treat it as an infrastructure failure (exit 3) so run-fleet.sh alerts.
    if not products and (registry_path or collection_dir):
        log(
            f"FATAL: {where} exists but parsed to ZERO products. "
            "This is a parser/registry-shape failure, not an empty catalog — the file would not "
            "be here otherwise. Common causes: entries built by a .map()/computed expression "
            "(this parser is a static regex and cannot evaluate one), or a quoting/field-name "
            "shape the parser does not recognise (see registry.py's alias lists), or a "
            "per-product content collection in a directory registry.py does not look in. "
            "NOT reporting green."
        )
        notify.post(
            site_root=site_root,
            channel=args.slack_channel or f"domain-{site_name.replace('.', '-')}",
            text=(
                f"🚨 {site_name} affiliate sentinel: registry "
                f"`{where}` parsed to 0 products. "
                "No cloaks or ASINs were checked. This site is currently UNMONITORED."
            ),
            color="danger",
        )
        return 3
    go_prefix = discover.detect_go_prefix(site_root)
    base_url = args.base_url or detect_base_url(site_root)
    tag = args.tag or detect_tag(site_root, registry_path)
    if not tag:
        # A tag of None makes every cloak's "is our tag on the outbound URL?"
        # assertion pass vacuously — the check most directly tied to whether
        # the site earns anything. Never let that be a silent condition.
        log(
            "WARNING: no Associates tag found (looked for AMAZON_TAG in "
            "lib/affiliate.ts, data/affiliate.ts, and the registry) — cloak "
            "checks cannot verify the outbound tag this run"
        )
    channel = args.slack_channel or f"domain-{site_name.replace('.', '-')}"
    log(f"registry: {len(products)} products | go_prefix={go_prefix} | base_url={base_url} | tag={tag}")

    ids, sources = discover.go_ids(site_root, go_prefix, {p.id for p in products if p.is_product})
    log(f"cloak ids: {len(ids)} from {', '.join(sources) or 'nothing'}")

    st = state_mod.load(site_root)
    by_id = {p.id: p for p in products}
    asin_products = [p for p in products if p.is_asin_backed]

    # ---- Check 1: ASIN health via the Creators API -------------------------
    health: dict[str, amz.AsinHealth] = {}
    api_error: str | None = None
    actionable_dead: list[tuple] = []
    actionable_oos: list[tuple] = []
    heals: list[heal_mod.HealResult] = []
    if asin_products:
        amz.load_env(site_root, domains_root)
        try:
            cl = amz.client(amz.token_cache_path())
        except RuntimeError as exc:
            api_error = str(exc)
            log(f"API unavailable: {exc}")
            cl = None
        if cl is not None:
            with cl:
                health = amz.check_health(cl, [p.asin for p in asin_products])
                log(
                    "api: "
                    + ", ".join(
                        f"{k}={sum(1 for h in health.values() if h.status == k)}"
                        for k in (amz.OK, amz.OOS, amz.SUSPECT_MISSING, amz.ERROR)
                    )
                )

                # If EVERY ASIN check errored, the API is down or the account
                # lost access — that is not "0 of 16 ASINs are live", which is
                # what the clean-verdict branch would cheerfully report. It ran
                # that way against the whole fleet while PA-API answered 403
                # "account does not currently meet the eligibility
                # requirements" for every single call.
                errored = [h for h in health.values() if h.status == amz.ERROR]
                if health and len(errored) == len(health):
                    api_error = errored[0].note or "every ASIN check failed"
                    log(f"API DOWN: all {len(health)} ASIN check(s) failed — {api_error}")
                    log("not reporting ASIN health this run; cloak checks still apply")
                    health = {}

                # Confirmation gate: PA-API "missing" is a suspicion, not a verdict.
                for h in health.values():
                    if h.status != amz.SUSPECT_MISSING:
                        continue
                    verdict = amz.confirm_dead(h.asin)
                    if verdict is True:
                        h.status = amz.CONFIRMED_DEAD
                        h.note = "absent from getItems AND direct fetch confirms dead"
                    elif verdict is False:
                        h.status = amz.OK
                        h.note = "PA-API omission artifact — direct fetch shows the product is live"
                    else:
                        h.note = "absent from getItems; direct fetch inconclusive (bot wall) — not acted on"

                # ---- Streaks -----------------------------------------------
                observed: set[str] = set()
                for p in asin_products:
                    h = health.get(p.asin)
                    if not h:
                        continue
                    if h.status == amz.CONFIRMED_DEAD:
                        key = f"dead:{p.id}"
                        observed.add(key)
                        n = state_mod.bump(st, key)
                        log(f"dead streak {p.id} ({p.asin}) = {n}/{args.confirm_runs}")
                        if n >= args.confirm_runs:
                            actionable_dead.append((p, h))
                    elif h.status == amz.OOS:
                        key = f"oos:{p.id}"
                        observed.add(key)
                        n = state_mod.bump(st, key)
                        log(f"oos streak {p.id} ({p.asin}) = {n}/{args.confirm_runs}")
                        if n >= args.confirm_runs:
                            actionable_oos.append((p, h))
                recovered = state_mod.reconcile(st, observed)
                for k in recovered:
                    log(f"recovered: {k}")

                # ---- Heal (the only AI spend) ------------------------------
                if actionable_dead and not args.no_heal:
                    for p, h in actionable_dead[: heal_mod.MAX_HEALS_PER_RUN]:
                        heals.append(
                            heal_mod.heal_product(
                                site_root=site_root,
                                registry_path=p.source or registry_path,
                                product=p,
                                dead_asin=p.asin,
                                cl=cl,
                                site_brand=brand,
                                model=args.model,
                                dry_run=args.dry_run,
                                log=log,
                            )
                        )
                        if heals[-1].healed:
                            state_mod.clear(st, f"dead:{p.id}")
                            # Re-parse: offsets shift after every applied edit.
                            products = registry_mod.parse_all(site_root, registry_path)
                            by_id = {q.id: q for q in products}
                    if len(actionable_dead) > heal_mod.MAX_HEALS_PER_RUN:
                        log(
                            f"heal: {len(actionable_dead)} dead but capped at "
                            f"{heal_mod.MAX_HEALS_PER_RUN} this run — remainder retried next run"
                        )
                elif actionable_dead:
                    log(f"--no-heal: {len(actionable_dead)} dead product(s) will be filed as tasks")
                    for p, _h in actionable_dead:
                        heals.append(
                            heal_mod.HealResult(p.id, p.asin, False, reason="healing disabled (--no-heal)")
                        )
    else:
        log("registry has no ASINs (search-URL registry) — API check not applicable")

    # ---- Check 2: /go/ cloak health on the live site -----------------------
    cloak_failures: list[cloak.CloakResult] = []
    cloak_retired: list[cloak.CloakResult] = []
    cloak_checked = 0
    site_gated: str | None = None
    check_ids = sorted(ids)
    # Content-collection sites carry hundreds to thousands of cloak routes, and
    # probing every one every night is a needless self-DDoS for no extra
    # signal — cloak breakage is near-always systemic (a bad route, a gated
    # site), not one link in isolation. Probe a bounded window and rotate the
    # starting point in state so full coverage still happens, just across runs.
    if args.max_cloak_checks and len(check_ids) > args.max_cloak_checks:
        offset = int(st.get("cloak_cursor", 0)) % len(check_ids)
        rotated = check_ids[offset:] + check_ids[:offset]
        check_ids = rotated[: args.max_cloak_checks]
        st["cloak_cursor"] = (offset + args.max_cloak_checks) % len(ids)
        log(
            f"cloak: {len(ids)} routes exceed --max-cloak-checks="
            f"{args.max_cloak_checks}; checking window from offset {offset}"
        )
    if base_url and check_ids:
        with cloak.make_client() as client:
            for pid in check_ids:
                p = by_id.get(pid)
                expected_asin = p.asin if p else None
                # A product we are about to replace will legitimately still
                # point at the dead ASIN; don't report that as a cloak fault.
                if any(h.product_id == pid and h.healed for h in heals):
                    expected_asin = None
                res = cloak.check(
                    client, base_url, go_prefix, pid, expected_asin, tag,
                    expected_url=(p.url if p else None),
                    # Lenient ONLY on a cloak-only run (nothing parsed at
                    # all). On a site that does have a registry, an id missing
                    # from it is a stale route worth flagging, as before.
                    registry_known=(p is not None or bool(products)),
                )
                cloak_checked += 1
                if res.retired:
                    cloak_retired.append(res)
                elif not res.ok:
                    cloak_failures.append(res)
                    log(f"cloak FAIL {pid}: {res.reason} (status={res.status})")
        # Site-wide condition, not N product bugs. A password-gated site (the
        # domains-add-password-protection-to-site skill is a supported fleet
        # state) serves its access page for EVERY path, so every cloak "fails"
        # identically. Reporting weapontester's 31 gated links as 31 broken
        # cloaks would file 31 engineering tasks for a site that is working
        # exactly as configured — and would drown the one run where something
        # is genuinely wrong.
        if (
            cloak_checked > 3
            and len(cloak_failures) == cloak_checked
            and len({r.reason for r in cloak_failures}) == 1
            and all(r.status == 200 for r in cloak_failures)
        ):
            gated_reason = cloak_failures[0].reason
            log(
                f"cloak: all {cloak_checked} routes returned an identical non-redirect 200 "
                f"— the site is access-gated, not broken. Suppressing per-link failures."
            )
            site_gated = gated_reason
            cloak_failures = []
        log(
            f"cloak: {cloak_checked - len(cloak_failures)}/{cloak_checked} healthy"
            + (f" ({len(cloak_retired)} deliberately retired)" if cloak_retired else "")
        )
    elif not base_url:
        log("no base_url detected — skipping cloak check")

    # ---- Check 2b: registry <-> _redirects static drift --------------------
    # The live cloak check above only covers ids it actually probed this run
    # (no base_url, an access-gated site, or the --max-cloak-checks rotation
    # window all leave some ids unprobed). `products.json`/`affiliate.ts` and
    # `_redirects` are two hand-maintained copies of the same ASIN, and a
    # manual edit to one without the other drifts silently — that's how
    # broadwayshowgirls' theatre-off-book-tshirt cloak pointed at a retired
    # ASIN for weeks. This is a local file read, not a network call, so it
    # runs unconditionally and covers every id the live check didn't reach.
    redirects_path = site_root / "site" / "public" / "_redirects"
    if redirects_path.is_file():
        redirects_text = redirects_path.read_text(encoding="utf-8", errors="replace")
        live_checked = set(check_ids) if base_url else set()
        for pid in sorted(ids - live_checked):
            p = by_id.get(pid)
            if not p or not p.asin:
                continue
            if any(h.product_id == pid and h.healed for h in heals):
                continue
            res = cloak.check_static(redirects_text, go_prefix, pid, p.asin, tag)
            if res is None:
                continue
            cloak_checked += 1
            if not res.ok:
                cloak_failures.append(res)
                log(f"cloak FAIL (static, unreached by live check) {pid}: {res.reason}")

    # ---- Write state, file tasks, commit -----------------------------------
    changed: list[Path] = []
    if not args.dry_run:
        st["last_run"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        changed.append(state_mod.save(site_root, st))

        for res in cloak_failures:
            p = by_id.get(res.id)
            body = (
                f"`{go_prefix}{res.id}` is not redirecting correctly on the live site.\n\n"
                f"- observed: {res.reason}\n- HTTP status: {res.status}\n"
                f"- redirect target: `{res.target or 'none'}`\n"
                f"- expected: `https://www.amazon.com/dp/{p.asin}?tag={tag}`\n"
                if p and p.asin
                else f"`{go_prefix}{res.id}` is not redirecting correctly on the live site.\n\n"
                f"- observed: {res.reason}\n- HTTP status: {res.status}\n"
                f"- redirect target: `{res.target or 'none'}`\n"
            )
            t = file_task(
                site_root, f"broken-cloak-{res.id}", "engineering",
                f"Broken affiliate cloak: {go_prefix}{res.id}", body, log,
            )
            if t:
                changed.append(t)

        for p, h in actionable_oos:
            t = file_task(
                site_root, f"oos-affiliate-{p.id}", "content",
                f"Out of stock: {p.name or p.id}",
                f"ASIN `{p.asin}` has been out of stock on {args.confirm_runs} consecutive runs.\n\n"
                f"Not auto-replaced — out-of-stock is usually temporary. Swap it if it stays gone.",
                log,
            )
            if t:
                changed.append(t)

        for res in heals:
            if res.healed:
                if res.unverified:
                    t = file_task(
                        site_root, f"verify-affiliate-{res.product_id}", "content",
                        f"Verify {', '.join(res.unverified)} for {res.product_id}",
                        f"`{res.product_id}` was auto-replaced ({res.dead_asin} → {res.new_asin}), "
                        f"but the Amazon API does not expose "
                        f"{', '.join(res.unverified)} for this account.\n\n"
                        f"Those fields still show the PREVIOUS product's values and are now "
                        f"wrong on the live page. Check the listing and correct them in "
                        f"`site/src/lib/affiliate.ts`.",
                        log,
                    )
                    if t:
                        changed.append(t)
                continue
            p = by_id.get(res.product_id)
            t = file_task(
                site_root, f"dead-affiliate-{res.product_id}", "content",
                f"Dead affiliate product: {p.name if p else res.product_id}",
                f"ASIN `{res.dead_asin}` is confirmed dead (API + direct fetch, "
                f"{args.confirm_runs} consecutive runs).\n\n"
                f"Auto-replacement did not ship: {res.reason}\n\nNeeds a human pick.",
                log,
            )
            if t:
                changed.append(t)

        healed_any = any(r.healed for r in heals)
        if healed_any:
            # Heals land in the registry file, in per-product JSON files, or
            # both, depending on the site's shape.
            changed.extend(
                sorted({r.edited_path for r in heals if r.healed and r.edited_path})
            )
            git(["add", "-A", "site/public"], site_root)

        if changed:
            for c in changed:
                git(["add", str(c.relative_to(site_root))], site_root)
            ids_ = ", ".join(r.product_id for r in heals if r.healed)
            n_tasks = len(changed) - 1  # everything except the state file
            if healed_any:
                msg = f"affiliate: auto-replace dead product(s) {ids_}"
            elif n_tasks:
                msg = f"affiliate: sentinel filed {n_tasks} task(s)"
            else:
                msg = "affiliate: sentinel state"
            if git(["commit", "-m", msg], site_root):
                log(f"committed: {msg}")
                git(["push"], site_root)
            if healed_any:
                (site_root / ".deploy-needed").touch()
                log("queued deploy (.deploy-needed)")

    # ---- Report ------------------------------------------------------------
    healed = [r for r in heals if r.healed]
    unhealed = [r for r in heals if not r.healed]
    ok_count = sum(1 for h in health.values() if h.status == amz.OK)

    # A run that checked NOTHING is the last shape that could still look green:
    # zero cloaks probed and zero ASIN verdicts obtained means every assertion
    # this tool makes was vacuous. It outranks the API-outage digest — an
    # outage on a site with cloaks still verifies the cloaks, but here nothing
    # was verified at all, so the site must say so in its own channel.
    nothing_checked = cloak_checked == 0 and not health

    if nothing_checked:
        emoji, color = notify.DEAD
        why = []
        if not base_url:
            why.append("no base_url could be detected")
        elif not ids:
            why.append(f"no {go_prefix} routes were discovered")
        if not asin_products:
            why.append("the registry declares no ASINs")
        elif api_error:
            why.append(f"the Amazon API is unavailable ({api_error})")
        verdict = (
            f"checked NOTHING — 0 cloaks and 0 ASINs verified across "
            f"{len(products)} registry entr{'y' if len(products) == 1 else 'ies'}"
            + (f" ({'; '.join(why)})" if why else "")
            + ". This site is effectively UNMONITORED"
        )
    elif healed:
        emoji, color = notify.HEALED
        verdict = f"{len(healed)} dead product(s) auto-replaced and deployed"
    elif unhealed or actionable_dead:
        emoji, color = notify.DEAD
        verdict = f"{len(actionable_dead)} dead product(s) — needs a human"
    elif cloak_failures or actionable_oos or api_error or site_gated:
        emoji, color = notify.WARN
        bits = []
        if site_gated:
            bits.append(f"site is access-gated — {cloak_checked} cloaks unverifiable")
        if cloak_failures:
            bits.append(f"{len(cloak_failures)} broken cloak(s)")
        if actionable_oos:
            bits.append(f"{len(actionable_oos)} out of stock")
        if api_error:
            # Name the count and the API's own reason. "Amazon API unavailable"
            # on its own reads as transient and got ignored; it was a standing
            # account-eligibility revocation, and every ASIN on the site was
            # going unchecked behind it.
            bits.append(
                f"Amazon API unavailable — {len(asin_products)} ASIN(s) UNCHECKED "
                f"({api_error})"
            )
        verdict = ", ".join(bits)
    else:
        emoji, color = notify.CLEAN
        verdict = f"{ok_count}/{len(asin_products)} ASINs live, {cloak_checked} cloaks OK"
        if cloak_retired:
            verdict += f" ({len(cloak_retired)} retired)"

    lines = [f"{emoji} {brand} affiliate sentinel — {today}: {verdict}."]
    for r in healed:
        lines.append(f"• 🔧 `{r.product_id}`: {r.dead_asin} → {r.new_asin} ({r.new_title}) — {r.reason}")
        if r.unverified:
            lines.append(
                f"    ⚠️ {', '.join(r.unverified)} could not be verified via the API and still "
                f"show the old product's values — task filed."
            )
    for r in unhealed:
        lines.append(f"• 🚨 `{r.product_id}`: {r.dead_asin} dead — {r.reason}")
    for res in cloak_failures[:8]:
        lines.append(
            f"• ⚠️ {notify.link(f'{base_url}{go_prefix}{res.id}/', res.id)}: {res.reason}"
        )
    for p, _h in actionable_oos[:5]:
        lines.append(f"• ⚠️ `{p.id}` out of stock ({p.asin})")

    text = "\n".join(lines)
    log(text)

    # A standing account-wide API outage is ONE fact, not 26 of them. When it is
    # the only thing wrong, saying so in every site channel every night trains
    # everyone to scroll past the sentinel — which costs more than the outage.
    # So: suppress the per-site line, exit 4, and let run-fleet.sh name every
    # affected site in a single fleet-ops message.
    #
    # This does not reintroduce silence. That digest fires every night the
    # outage lasts, so a quiet fleet channel still means the sweep itself is
    # dead; and the instant a site has any finding of its OWN — a dead ASIN, a
    # broken cloak — it is no longer outage-only and speaks in its own channel
    # again, with the UNCHECKED count included.
    api_outage_only = bool(api_error) and not (
        healed or unhealed or actionable_dead or cloak_failures or actionable_oos
        or site_gated or nothing_checked
    )
    # Written on a dry run too: it is diagnostics that live beside the log file
    # a dry run already writes, and skipping it made --dry-run sweeps report a
    # dishonest "0 ASIN(s) UNCHECKED" digest.
    write_outage_marker(
        site_root, today, len(asin_products), api_error if api_outage_only else None
    )
    suppressed = api_outage_only and not args.post_api_outage
    if suppressed:
        log(
            "per-site Slack suppressed: an API outage is the only finding — "
            "reported once fleet-wide instead (exit 4)"
        )
    if not args.dry_run and not suppressed:
        notify.post(site_root, channel, text, color)

    if args.json:
        print(json.dumps({
            "site": site_name,
            "products": len(products),
            "asins": len(asin_products),
            "ok": ok_count,
            "cloaks_checked": cloak_checked,
            "cloak_failures": [r.__dict__ for r in cloak_failures],
            "cloak_retired": [r.id for r in cloak_retired],
            "healed": [r.__dict__ for r in healed],
            "unhealed": [r.__dict__ for r in unhealed],
            "api_error": api_error,
            "verdict": verdict,
            "api_outage_only": api_outage_only,
            "nothing_checked": nothing_checked,
        }, indent=2, default=str))

    if nothing_checked:
        # Exit 5, not 0: run-fleet.sh counts it as a site that did not really
        # complete, so a vacuous run can never be part of a clean sweep line.
        return 5
    return 4 if suppressed else 0


if __name__ == "__main__":
    sys.exit(main())
