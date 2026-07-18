import pytest
from googleapiclient.errors import HttpError

from ga4_provision import grant


class FakeBindings:
    def __init__(self, existing=None, error=None):
        self.existing = existing or []
        self.error = error
        self.created = []

    def list(self, parent=None, **kw):
        bindings = [{"user": e} for e in self.existing]
        return type("R", (), {"execute": lambda _s: {"accessBindings": bindings}})()

    def list_next(self, request, response):
        return None

    def create(self, parent=None, body=None):
        if self.error:
            raise self.error
        self.created.append((parent, body))
        return type("R", (), {"execute": lambda _s: {"name": "ok"}})()


def _client(bindings):
    return type("C", (), {"properties": lambda _s: type(
        "P", (), {"accessBindings": lambda _p: bindings})()})()


def test_grant_creates_binding_when_absent():
    b = FakeBindings()
    result = grant.grant_viewer(_client(b), "123", "sa@domains-ops.iam.gserviceaccount.com")
    assert result == "granted"
    assert b.created[0][0] == "properties/123"
    assert b.created[0][1]["roles"] == ["predefinedRoles/viewer"]


def test_grant_is_idempotent():
    b = FakeBindings(existing=["sa@domains-ops.iam.gserviceaccount.com"])
    result = grant.grant_viewer(_client(b), "123", "sa@domains-ops.iam.gserviceaccount.com")
    assert result == "already"
    assert b.created == []


def test_grant_failure_is_reported_not_raised():
    err = HttpError(type("R", (), {"status": 403, "reason": "Forbidden"})(), b"denied")
    b = FakeBindings(error=err)
    result = grant.grant_viewer(_client(b), "123", "sa@domains-ops.iam.gserviceaccount.com")
    assert result.startswith("failed:")
