"""Per-repo GitHub collectors. Each returns a dict with `ok: bool`; on failure
it records the error string and never raises, so one bad repo doesn't kill the
snapshot. Mirrors cf-stats' collector contract."""
from __future__ import annotations

from .api import GHClient, GHError


def _err(e: Exception) -> dict:
    if isinstance(e, GHError):
        return {"ok": False, "status": e.status, "error": f"{e.status}: {e.message}"}
    return {"ok": False, "status": 0, "error": str(e)}


def _last_main_commit(gh: GHClient, slug: str, default_branch: str) -> dict | None:
    """Last commit on the repo's main branch. Returns None if the branch is
    empty/absent (409/404) rather than raising."""
    branch = "main" if default_branch in (None, "") else default_branch
    try:
        commits = gh.get(f"/repos/{slug}/commits", params={"sha": "main", "per_page": 1})
    except GHError as e:
        if e.status in (404, 409, 422):
            # 'main' may not exist; fall back to the default branch once.
            if branch != "main":
                try:
                    commits = gh.get(f"/repos/{slug}/commits",
                                     params={"sha": branch, "per_page": 1})
                except GHError:
                    return None
            else:
                return None
        else:
            raise
    if not commits:
        return None
    c = commits[0]
    return {
        "sha": (c.get("sha") or "")[:7],
        "date": ((c.get("commit") or {}).get("committer") or {}).get("date"),
        "message": ((c.get("commit") or {}).get("message") or "").splitlines()[0][:120],
    }


def collect_repo(gh: GHClient, domain: str, slug: str) -> dict:
    """Snapshot one repo: default branch, branches, last main commit, open PRs."""
    try:
        meta = gh.get(f"/repos/{slug}")
    except Exception as e:
        return {**_err(e), "slug": slug}

    default_branch = meta.get("default_branch")
    try:
        branches = [b.get("name") for b in gh.get(
            f"/repos/{slug}/branches", params={"per_page": 100}) if b.get("name")]
    except Exception:
        branches = []

    try:
        last_commit = _last_main_commit(gh, slug, default_branch)
    except Exception:
        last_commit = None

    try:
        pulls = gh.get(f"/repos/{slug}/pulls",
                       params={"state": "open", "per_page": 50})
        open_prs = [{"number": p.get("number"), "title": (p.get("title") or "")[:120],
                     "head": (p.get("head") or {}).get("ref")} for p in pulls]
    except Exception:
        open_prs = []

    return {
        "ok": True,
        "slug": slug,
        "default_branch": default_branch,
        "visibility": meta.get("visibility"),
        "branches": branches,
        "branch_count": len(branches),
        "last_main_commit": last_commit,
        "open_prs": open_prs,
        "open_pr_count": len(open_prs),
    }
