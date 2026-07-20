import os
from typing import Literal
import yaml
from pydantic import BaseModel, Field

DEFAULT_HOME_IPS = {"24.55.143.75", "158.173.25.169"}


class Source(BaseModel):
    id: str
    type: Literal["rss", "dataset"]
    url: str | None = None
    dataset_key: str | None = None
    fetcher: str | None = None
    params: dict = Field(default_factory=dict)
    tags: list[str]
    policy: Literal["vpn", "direct"] = "vpn"
    exit: Literal["us", "eu", "any"] = "any"
    fetch: dict = Field(default_factory=dict)
    # Per-source kill-switch. Set `enabled: false` in the registry to stop
    # fetching a source without removing it (e.g. a feed whose WAF blocks the
    # VPN exit IPs). The collector skips it and marks its state "disabled".
    enabled: bool = True


class ItemsQuery(BaseModel):
    tags_any: list[str] = Field(default_factory=list)
    tags_all: list[str] = Field(default_factory=list)
    include_sources: list[str] = Field(default_factory=list)
    exclude_sources: list[str] = Field(default_factory=list)
    limit: int = 200
    window_hours: int = 48


class Subscription(BaseModel):
    site: str
    items: ItemsQuery = Field(default_factory=ItemsQuery)
    datasets: list[str] = Field(default_factory=list)


class AnalyticsSite(BaseModel):
    ga4_property_id: str
    ga4_measurement_id: str | None = None
    gsc_property: str
    consent_gated: bool = False


class Settings(BaseModel):
    db_path: str
    home_ips: set[str]
    proxy_us: str
    proxy_eu: str
    control_us: str
    control_eu: str
    registry_dir: str
    fred_key: str = ""
    nass_key: str = ""
    eia_key: str = ""
    gnews_key: str = ""
    retention_days: int = 7   # data lifecycle: rows older than this are pruned each cycle

    @classmethod
    def from_env(cls) -> "Settings":
        home = os.environ.get("DATAHUB_HOME_IPS", "")
        home_ips = {ip.strip() for ip in home.split(",") if ip.strip()} or set(DEFAULT_HOME_IPS)
        # Inside a container, callers set DATAHUB_PROXY_HOST=host.docker.internal.
        host = os.environ.get("DATAHUB_PROXY_HOST", "127.0.0.1")
        return cls(
            db_path=os.environ.get("DATAHUB_DB_PATH", "/data/data-hub.db"),
            home_ips=home_ips,
            proxy_us=os.environ.get("DATAHUB_PROXY_US", f"http://{host}:8181"),
            proxy_eu=os.environ.get("DATAHUB_PROXY_EU", f"http://{host}:8182"),
            control_us=os.environ.get("DATAHUB_CONTROL_US", f"http://{host}:9281"),
            control_eu=os.environ.get("DATAHUB_CONTROL_EU", f"http://{host}:9282"),
            registry_dir=os.environ.get("DATAHUB_REGISTRY_DIR", "/app/registry"),
            fred_key=os.environ.get("FRED_API_KEY", ""),
            nass_key=os.environ.get("NASS_API_KEY", ""),
            eia_key=os.environ.get("EIA_API_KEY", ""),
            gnews_key=os.environ.get("GNEWS_API_KEY", ""),
            retention_days=int(os.environ.get("DATAHUB_RETENTION_DAYS", "7")),
        )


def load_sources(path: str) -> list[Source]:
    data = yaml.safe_load(open(path, encoding="utf-8").read()) or {}
    return [Source(**s) for s in data.get("sources", [])]


def load_subscriptions(path: str) -> dict[str, Subscription]:
    data = yaml.safe_load(open(path, encoding="utf-8").read()) or {}
    out: dict[str, Subscription] = {}
    for site, body in (data.get("subscriptions") or {}).items():
        body = dict(body or {})
        body["site"] = site
        out[site] = Subscription(**body)
    return out


def load_analytics_registry(path: str) -> dict[str, "AnalyticsSite"]:
    """Read registry/sites-analytics.yaml (written by tools/ga4-provision).

    Missing file returns {} rather than raising — this registry only exists
    after ga4-provision has run at least once, and the collector must not
    crash before that one-time step has happened.
    """
    if not os.path.exists(path):
        return {}
    data = yaml.safe_load(open(path, encoding="utf-8").read()) or {}
    return {domain: AnalyticsSite(**body) for domain, body in (data.get("sites") or {}).items()}
