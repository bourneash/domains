"""Adapter registry.

Adapter classes are imported lazily by name so a broken/uninstalled SDK for one
platform can never stop the hub from serving or from posting to the others —
an import error surfaces as that platform being unavailable, not as a dead
process.
"""

from __future__ import annotations

import importlib
from typing import Type

from social_hub.platforms.base import (  # re-exported for convenience
    Adapter,
    AdapterError,
    Capabilities,
    Mention,
    Outgoing,
    PostRef,
)

REGISTRY: dict[str, tuple[str, str]] = {
    "bluesky": ("social_hub.platforms.bluesky", "BlueskyAdapter"),
    "x": ("social_hub.platforms.x", "XAdapter"),
    "reddit": ("social_hub.platforms.reddit", "RedditAdapter"),
    "mastodon": ("social_hub.platforms.mastodon", "MastodonAdapter"),
    "pinterest": ("social_hub.platforms.pinterest", "PinterestAdapter"),
    "console": ("social_hub.platforms.console", "ConsoleAdapter"),
}

#: Test/dev hook — populated by tests to swap in fakes without monkeypatching
#: every call site. Checked before REGISTRY.
OVERRIDES: dict[str, Type[Adapter]] = {}


def platform_names() -> list[str]:
    return sorted(set(REGISTRY) | set(OVERRIDES))


def adapter_class(platform: str) -> Type[Adapter]:
    if platform in OVERRIDES:
        return OVERRIDES[platform]
    if platform not in REGISTRY:
        raise KeyError(f"unknown platform: {platform}")
    module_name, class_name = REGISTRY[platform]
    module = importlib.import_module(module_name)
    return getattr(module, class_name)


def get_adapter(platform: str, creds: dict | None = None) -> Adapter:
    return adapter_class(platform)(creds or {})


def capabilities(platform: str) -> Capabilities:
    try:
        return adapter_class(platform).caps
    except Exception:
        return Capabilities(publish=False)


__all__ = [
    "Adapter",
    "AdapterError",
    "Capabilities",
    "Mention",
    "Outgoing",
    "PostRef",
    "REGISTRY",
    "OVERRIDES",
    "adapter_class",
    "capabilities",
    "get_adapter",
    "platform_names",
]
