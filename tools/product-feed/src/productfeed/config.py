"""Settings + registry (subscriptions.yaml) loading for product-feed.

Mirrors tools/data-hub/src/datahub/config.py's shape: a small env-driven
Settings dataclass, plus a loader for the one registry file this service
reads (subscriptions.yaml — no `sources.yaml` here, product-feed doesn't
fetch anything itself, it only stores and routes what site-side sourcing
roles push to it).
"""
import os
from dataclasses import dataclass, field

import yaml


@dataclass
class Settings:
    db_path: str = "/data/product-feed.db"
    registry_dir: str = os.path.join(os.path.dirname(__file__), "..", "..", "registry")
    host: str = "127.0.0.1"
    port: int = 4761

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            db_path=os.environ.get("PRODUCTFEED_DB_PATH", cls.db_path),
            registry_dir=os.environ.get("PRODUCTFEED_REGISTRY_DIR", cls.registry_dir),
            host=os.environ.get("PRODUCTFEED_HOST", cls.host),
            port=int(os.environ.get("PRODUCTFEED_PORT", cls.port)),
        )


@dataclass
class Subscription:
    site: str
    tags_any: list[str] = field(default_factory=list)
    site_origin_allow: list[str] | None = None
    max_queue_depth: int | None = None


def load_subscriptions(path: str) -> dict[str, Subscription]:
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        raw = yaml.safe_load(f) or {}
    out: dict[str, Subscription] = {}
    for site, cfg in raw.items():
        cfg = cfg or {}
        out[site] = Subscription(
            site=site,
            tags_any=[str(t) for t in (cfg.get("tags_any") or [])],
            site_origin_allow=(
                [str(s) for s in cfg["site_origin_allow"]] if cfg.get("site_origin_allow") else None
            ),
            max_queue_depth=cfg.get("max_queue_depth"),
        )
    return out
