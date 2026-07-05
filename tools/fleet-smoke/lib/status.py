"""Per-site last-run state, and the healthy/recovered/attention decision."""
import json
import os


def _state_path(state_dir, site_name):
    return os.path.join(state_dir, f"{site_name}.json")


def load_state(state_dir, site_name):
    path = _state_path(state_dir, site_name)
    if not os.path.exists(path):
        return {"fail": 0}
    with open(path) as f:
        return json.load(f)


def save_state(state_dir, site_name, fail_count):
    os.makedirs(state_dir, exist_ok=True)
    path = _state_path(state_dir, site_name)
    with open(path, "w") as f:
        json.dump({"fail": fail_count}, f)


def compute_status(fail_count, prev_fail_count):
    """Icon/color/word for this run, based on this run's fail count vs. the
    last run's. 'recovered' means the fleet self-healed between two ticks —
    no LLM diagnosis required, just a before/after comparison."""
    if fail_count == 0 and prev_fail_count > 0:
        return (":wrench:", "warning", "recovered")
    if fail_count == 0:
        return (":white_check_mark:", "good", "healthy")
    return (":sos:", "danger", "attention")
