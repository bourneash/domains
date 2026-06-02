"""Shared fixtures for cf-stats tests."""
from __future__ import annotations

import pytest

from cf_stats.api import CFClient


@pytest.fixture
def cf() -> CFClient:
    # account id is arbitrary in tests; respx intercepts all HTTP.
    return CFClient(token="test-token", account_id="acct123")
