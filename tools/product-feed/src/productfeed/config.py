"""Settings and registry loading for the shared Amazon product feed."""
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
    target_available_depth: int = 24
    review_batch_size: int = 4


@dataclass
class SourceQuery:
    id: str
    query: str
    tags: list[str] = field(default_factory=list)
    enabled: bool = True
    priority: int = 50


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
            target_available_depth=int(cfg.get("target_available_depth", 24)),
            review_batch_size=int(cfg.get("review_batch_size", 4)),
        )
    return out


def load_source_queries(path: str) -> list[SourceQuery]:
    if not os.path.exists(path):
        return []
    with open(path) as f:
        raw = yaml.safe_load(f) or {}
    queries = []
    for cfg in raw.get("queries", []):
        cfg = cfg or {}
        if not cfg.get("id") or not cfg.get("query"):
            continue
        queries.append(
            SourceQuery(
                id=str(cfg["id"]),
                query=str(cfg["query"]),
                tags=[str(tag) for tag in (cfg.get("tags") or [])],
                enabled=bool(cfg.get("enabled", True)),
                priority=int(cfg.get("priority", 50)),
            )
        )
    return sorted((query for query in queries if query.enabled), key=lambda q: -q.priority)
