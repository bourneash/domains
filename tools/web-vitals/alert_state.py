"""Reduce one scheduled Lighthouse report to alert transitions.

Moderate LCP-only breaches need two consecutive measurements. Lighthouse's
single-run mobile LCP varies enough to cross 2.5 s and recover the next day;
one sample should stay visible in the report without paging the site owner.
"""


def transition(report: dict, previous: dict, factor: str) -> tuple[list[dict], dict]:
    old = previous.get("active") or {}
    old_pending = previous.get("pending") or {}
    active = {}
    pending = {}
    rows = {row["site"]: row for row in report.get("sites", []) if row.get("site")}

    for site, row in rows.items():
        if row.get("error"):
            signature = "error:" + str(row["error"])
        elif row.get("warnings"):
            signature = "warning:" + ";".join(sorted(str(w) for w in row["warnings"]))
        elif row.get("status") == "skipped":
            # A skipped measurement cannot establish or clear an alert.
            if site in old:
                active[site] = old[site]
            if site in old_pending:
                pending[site] = old_pending[site]
            continue
        else:
            flags = set(row.get("budget_breaches") or []) | set(row.get("regressions") or [])
            signature = ",".join(sorted(flags))

        if not signature:
            continue
        lcp = (row.get("metrics") or {}).get("lcp_ms")
        if signature == "lcp_ms" and old.get(site) != signature and (lcp is None or lcp < 4000):
            prior = old_pending.get(site) or {}
            count = prior.get("count", 0) + 1 if prior.get("signature") == signature else 1
            if count < 2:
                pending[site] = {"signature": signature, "count": count}
                continue
        active[site] = signature

    events = []
    for site, signature in sorted(active.items()):
        if old.get(site) == signature:
            continue
        row = rows[site]
        if row.get("error"):
            headline = f"{factor} vitals sweep could not measure site"
            detail = str(row["error"])
        elif signature.startswith("warning:"):
            headline = f"{factor} web-vitals configuration needs attention"
            detail = signature[len("warning:"):]
        else:
            metrics = row.get("metrics") or {}
            headline = f"{factor} web vitals need attention"
            detail = (f"flags={signature}; performance={metrics.get('performance')}; "
                      f"LCP={metrics.get('lcp_ms')}ms; CLS={metrics.get('cls')}")
        events.append({"status": "warn", "site": site, "headline": headline, "detail": detail})
    for site in sorted(set(old) - set(active)):
        if site not in rows or rows[site].get("status") == "skipped":
            continue
        events.append({"status": "ok", "site": site,
                       "headline": f"{factor} web vitals recovered",
                       "detail": "The latest sweep has no active budget, regression, or measurement errors."})

    state = {"at": report.get("at"), "form_factor": factor, "active": active, "pending": pending}
    return events, state
