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
    "inconclusive": "inconclusive_grace_runs",
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

    if verdict == "inconclusive" and entry is not None and entry.get("issue") != "inconclusive":
        # Anti-bot wall / Amazon-side error landing on top of a DIFFERENT
        # issue already in progress (e.g. a genuine OOS streak) — a single
        # noisy read must never advance or reset that unrelated streak.
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
