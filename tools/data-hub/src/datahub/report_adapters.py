"""Validated adapter boundary for fishing reports.

Only the local seed adapter is enabled initially. Network adapters must be
explicitly implemented and reviewed for source permission/robots policy before
they are registered; the hub never guesses how to scrape a charter website.
"""
import hashlib
import json
import re
from datetime import date, datetime
from pathlib import Path
from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


class ReportAdapter(Protocol):
    def load(self) -> tuple[dict, list[dict]]: ...


class SpeciesFact(BaseModel):
    model_config = ConfigDict(extra="forbid")
    species: str = Field(min_length=2)
    species_slug: str | None = None
    catch_count: int | None = Field(default=None, ge=0)
    disposition: str | None = None
    min_size: float | None = Field(default=None, ge=0)
    max_size: float | None = Field(default=None, ge=0)
    size_unit: str | None = None


class SeedReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    external_id: str | None = None
    url: HttpUrl
    title: str = Field(min_length=2)
    summary: str = ""
    report_date: date
    published_at: datetime | None = None
    port: str | None = None
    state: str | None = None
    region: str | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    area: str | None = None
    report_type: str = "charter"
    methods: list[str] = Field(default_factory=list)
    conditions: dict = Field(default_factory=dict)
    confidence: float = Field(default=0.5, ge=0, le=1)
    evidence_excerpt: str = Field(default="", max_length=500)
    species: list[SpeciesFact] = Field(min_length=1)

    @model_validator(mode="after")
    def size_ranges_are_ordered(self):
        for fact in self.species:
            if fact.min_size is not None and fact.max_size is not None and fact.min_size > fact.max_size:
                raise ValueError("species min_size cannot exceed max_size")
        return self


class SeedSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]+$")
    name: str = Field(min_length=2)
    homepage_url: HttpUrl
    source_type: str = "manual-seed"
    provenance: str = Field(min_length=4)
    default_port: str | None = None
    default_state: str | None = None
    default_region: str | None = None
    default_lat: float | None = Field(default=None, ge=-90, le=90)
    default_lon: float | None = Field(default=None, ge=-180, le=180)
    enabled: bool = True


class SeedDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: SeedSource
    reports: list[SeedReport] = Field(min_length=1)


class SeedFileAdapter:
    """Read a human-reviewed JSON seed document; performs no network access."""
    def __init__(self, path: str | Path):
        self.path = Path(path)

    def load(self) -> tuple[dict, list[dict]]:
        doc = SeedDocument.model_validate_json(self.path.read_text(encoding="utf-8"))
        source = doc.source.model_dump(mode="json")
        reports = []
        for record in doc.reports:
            row = record.model_dump(mode="json")
            url = str(row["url"])
            row["external_id"] = row.get("external_id") or hashlib.sha256(url.encode()).hexdigest()[:24]
            row["source_id"] = source["source_id"]
            row["port"] = row.get("port") or source.get("default_port")
            row["state"] = row.get("state") or source.get("default_state")
            row["region"] = row.get("region") or source.get("default_region")
            row["lat"] = row.get("lat") if row.get("lat") is not None else source.get("default_lat")
            row["lon"] = row.get("lon") if row.get("lon") is not None else source.get("default_lon")
            normalized_species = []
            for fact in row["species"]:
                verbatim = fact.pop("species")
                supplied_slug = fact.pop("species_slug", None)
                normalized_species.append({
                    "species_slug": supplied_slug or _slug(verbatim),
                    "species_verbatim": verbatim,
                    **fact,
                })
            row["species"] = normalized_species
            row["raw"] = record.model_dump(mode="json")
            canonical = json.dumps(row["raw"], sort_keys=True, separators=(",", ":"))
            row["content_hash"] = hashlib.sha256(canonical.encode()).hexdigest()
            reports.append(row)
        return source, reports
