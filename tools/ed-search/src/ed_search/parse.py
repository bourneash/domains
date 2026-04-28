from __future__ import annotations

from bs4 import BeautifulSoup


def _cell_value(td) -> str:
    """Return the primary value of a cell.

    expireddomains.net cells typically contain: the value, then a strip of
    registrar/SEO tool links (Namecheap, GoDaddy, Majestic, etc). We want only
    the value. Strategy:

    1. Strip secondary anchor lists by removing all links pointing to external
       hosts or to anchor-only `?…` query strings AFTER the first link.
    2. Take direct text of the first child <a>, else the cell's first non-link
       text node, else the full text.
    """
    # First <a> with a useful name
    first_a = td.find("a")
    if first_a is not None:
        # If the first link's text equals the cell's leading non-whitespace token
        # use it. Otherwise fall back to first text node.
        a_text = first_a.get_text(" ", strip=True)
        if a_text:
            # Ignore icon-only links (one-char text)
            if len(a_text) > 1:
                return a_text

    # First non-empty text node
    for s in td.stripped_strings:
        return s

    return td.get_text(" ", strip=True)


def parse_results_table(html: str) -> list[dict[str, str]]:
    """Parse an expireddomains.net results table into row dicts."""
    soup = BeautifulSoup(html, "lxml")
    table = soup.find("table", class_="base1") or soup.find("table")
    if table is None:
        return []

    headers: list[str] = []
    head_row = table.find("tr")
    if head_row:
        headers = [
            th.get_text(strip=True).lower().replace(" ", "_") or f"col{i}"
            for i, th in enumerate(head_row.find_all(["th", "td"]))
        ]

    rows: list[dict[str, str]] = []
    for tr in table.find_all("tr")[1:]:
        cells = tr.find_all("td")
        if not cells:
            continue
        row = {
            headers[i] if i < len(headers) else f"col{i}": _cell_value(td)
            for i, td in enumerate(cells)
        }
        if "domain" not in row:
            for k in ("name", "domain_name"):
                if k in row:
                    row["domain"] = row[k]
                    break
        rows.append(row)
    return rows


def find_pagination_next(html: str) -> str | None:
    """Return relative URL of the next-page link, if present."""
    soup = BeautifulSoup(html, "lxml")
    nxt = soup.find("a", string=lambda s: s and "next" in s.lower())
    if nxt and nxt.get("href"):
        return nxt["href"]
    # Fallback: look for rel=next or class containing "next"
    nxt = soup.find("a", attrs={"rel": "next"}) or soup.find(
        "a", class_=lambda c: c and "next" in c
    )
    if nxt and nxt.get("href"):
        return nxt["href"]
    return None
