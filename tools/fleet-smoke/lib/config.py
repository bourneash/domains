"""Discover and load per-site smoke.yaml configs."""
import glob
import os

import yaml


def discover_configs(sites_dir):
    """Return sorted [(site_dir, config_path), ...] for every sites/*/ops/smoke.yaml."""
    pattern = os.path.join(sites_dir, "*", "ops", "smoke.yaml")
    paths = sorted(glob.glob(pattern))
    return [(os.path.dirname(os.path.dirname(p)), p) for p in paths]


def load_config(config_path):
    """Load one site's smoke.yaml, filling in defaults for omitted keys."""
    with open(config_path) as f:
        data = yaml.safe_load(f) or {}

    data.setdefault("enabled", True)
    data.setdefault("dns_over_https", True)
    data.setdefault("slack", {})
    data["slack"].setdefault("enabled", True)
    data.setdefault("checks", [])
    return data
