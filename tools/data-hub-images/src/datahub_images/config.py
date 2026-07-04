import os
import yaml
from dataclasses import dataclass
from pydantic import BaseModel

# Copied verbatim from tools/data-hub/src/datahub/config.py DEFAULT_HOME_IPS.
DEFAULT_HOME_IPS = {"24.55.143.75", "158.173.25.169"}


class Source(BaseModel):
    id: str
    kind: str
    url: str | None = None
    policy: str = "vpn"
    exit: str = "any"
    enabled: bool = True
    key_env: str | None = None
    params: dict = {}


class Topic(BaseModel):
    id: str
    queries: list[str]
    target_depth: int = 12
    reuse_global_days: int | None = None
    tags: list[str] = []


@dataclass
class Settings:
    db_path: str
    blob_dir: str
    proxy_us: str
    proxy_eu: str
    home_ips: set
    pool_ttl_days: int
    retention_days: int
    reuse_global_days: int
    reuse_same_site_days: int
    api_host: str
    api_port: int

    @classmethod
    def from_env(cls):
        host = os.environ.get("DATAHUB_IMAGES_PROXY_HOST", "127.0.0.1")
        home = os.environ.get("DATAHUB_IMAGES_HOME_IPS")
        return cls(
            db_path=os.environ.get("DATAHUB_IMAGES_DB_PATH", "/data/images.db"),
            blob_dir=os.environ.get("DATAHUB_IMAGES_BLOB_DIR", "/data/blobs"),
            proxy_us=os.environ.get("DATAHUB_IMAGES_PROXY_US", f"http://{host}:8181"),
            proxy_eu=os.environ.get("DATAHUB_IMAGES_PROXY_EU", f"http://{host}:8182"),
            home_ips=({p.strip() for p in home.split(",") if p.strip()} if home else set(DEFAULT_HOME_IPS)),
            pool_ttl_days=int(os.environ.get("DATAHUB_IMAGES_POOL_TTL_DAYS", "45")),
            retention_days=int(os.environ.get("DATAHUB_IMAGES_RETENTION_DAYS", "14")),
            reuse_global_days=int(os.environ.get("DATAHUB_IMAGES_REUSE_GLOBAL_DAYS", "30")),
            reuse_same_site_days=int(os.environ.get("DATAHUB_IMAGES_REUSE_SAME_SITE_DAYS", "14")),
            api_host=os.environ.get("DATAHUB_IMAGES_API_HOST", "0.0.0.0"),
            api_port=int(os.environ.get("DATAHUB_IMAGES_API_PORT", "4770")),
        )


def load_sources(path: str) -> list[Source]:
    with open(path) as f:
        return [Source(**d) for d in (yaml.safe_load(f) or [])]


def load_topics(path: str) -> list[Topic]:
    with open(path) as f:
        return [Topic(**d) for d in (yaml.safe_load(f) or [])]
