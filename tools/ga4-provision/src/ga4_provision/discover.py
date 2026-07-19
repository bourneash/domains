"""Authoritative GA4 property discovery via the Admin API.

The two hardcoded property lists in this repo disagree with each other and
with reality. This is the only trustworthy source.
"""
from __future__ import annotations

from dataclasses import dataclass, field

ACCOUNT_ID = "396394354"  # "Domain Portfolio"


@dataclass
class Property:
    property_id: str
    display_name: str
    account_id: str
    measurement_ids: list[str] = field(default_factory=list)


def discover_properties(client, account_id: str = ACCOUNT_ID) -> list[Property]:
    """List every GA4 property under the account, following pagination."""
    props: list[Property] = []
    api = client.properties()
    request = api.list(filter=f"parent:accounts/{account_id}", pageSize=200)

    while request is not None:
        response = request.execute()
        for p in response.get("properties", []):
            name = p["name"]
            parent = p["parent"]
            property_id = name.split("/")[-1]
            account_id_value = parent.split("/")[-1]
            if not property_id:
                raise ValueError(f"malformed property resource name: {name!r}")
            if not account_id_value:
                raise ValueError(f"malformed property parent: {parent!r}")
            props.append(
                Property(
                    property_id=property_id,
                    display_name=p.get("displayName", ""),
                    account_id=account_id_value,
                )
            )
        request = api.list_next(request, response)

    return props
