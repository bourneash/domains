"""Shared fixtures for gh-stats tests."""
from __future__ import annotations

import pytest

from gh_stats.api import GHClient


@pytest.fixture
def gh() -> GHClient:
    return GHClient(token="test-pat")
