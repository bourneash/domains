from googleapiclient.errors import HttpError

from ga4_provision import grant


class FakeRequest:
    """Models a google-api-python-client request object: .execute() -> page."""

    def __init__(self, page):
        self._page = page

    def execute(self):
        return self._page


class FakeBindings:
    def __init__(self, existing=None, pages=None, error=None):
        # Legacy single-page mode: existing list of user emails
        if pages is None and existing is not None:
            pages = [{"accessBindings": [{"user": e} for e in existing]}]
        self.pages = pages or [{"accessBindings": []}]
        self._page_index = 0
        self.error = error
        self.created = []

    def list(self, parent=None, **kw):
        page = self.pages[self._page_index]
        self._page_index += 1
        return FakeRequest(page)

    def list_next(self, request, response):
        if self._page_index >= len(self.pages):
            return None
        page = self.pages[self._page_index]
        self._page_index += 1
        return FakeRequest(page)

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


def test_grant_finds_binding_on_second_page():
    # Pagination test: service account binding is on page 2, not page 1.
    # If list_next returned None unconditionally, this binding would be missed,
    # and grant_viewer would incorrectly call create() and return "granted".
    pages = [
        {"accessBindings": [{"user": "other@example.iam.gserviceaccount.com"}]},
        {"accessBindings": [{"user": "sa@domains-ops.iam.gserviceaccount.com"}]},
    ]
    b = FakeBindings(pages=pages)
    result = grant.grant_viewer(_client(b), "123", "sa@domains-ops.iam.gserviceaccount.com")
    assert result == "already", "Should find binding on page 2 and return 'already'"
    assert b.created == [], "Should not create a duplicate binding"


def test_grant_failure_is_reported_not_raised():
    err = HttpError(type("R", (), {"status": 403, "reason": "Forbidden"})(), b"denied")
    b = FakeBindings(error=err)
    result = grant.grant_viewer(_client(b), "123", "sa@domains-ops.iam.gserviceaccount.com")
    assert result.startswith("failed:")
