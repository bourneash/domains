from googleapiclient.errors import HttpError

from gsc_verify import verification


class FakeWebResource:
    def __init__(self, verified=(), error=None):
        self.verified = set(verified)
        self.error = error
        self.inserted = []

    def list(self):
        items = [{"site": {"type": "INET_DOMAIN", "identifier": d}} for d in self.verified]
        return type("R", (), {"execute": lambda _s: {"items": items}})()

    def insert(self, verificationMethod=None, body=None):
        if self.error:
            raise self.error
        self.inserted.append((verificationMethod, body))
        return type("R", (), {"execute": lambda _s: {"id": "dns://example.com"}})()


def _client(web=None):
    resource = web or FakeWebResource()
    return type("C", (), {"webResource": lambda _s: resource})()


def test_get_token_requests_dns_txt_method():
    class TokenResource(FakeWebResource):
        def getToken(self, body=None):
            assert body["verificationMethod"] == "DNS_TXT"
            assert body["site"]["identifier"] == "example.com"
            return type("R", (), {"execute": lambda _s: {"token": "TOKEN123"}})()

    assert verification.get_token(_client(TokenResource()), "example.com") == "TOKEN123"


def test_dns_record_name_is_the_bare_domain():
    assert verification.dns_record_name("example.com") == "example.com"


def test_is_verified_true_when_listed():
    web = FakeWebResource(verified=["example.com"])
    assert verification.is_verified(_client(web), "example.com") is True


def test_is_verified_false_when_absent():
    web = FakeWebResource(verified=["other.com"])
    assert verification.is_verified(_client(web), "example.com") is False


def test_verify_returns_verified_on_success():
    web = FakeWebResource()
    result = verification.verify(_client(web), "example.com")
    assert result == "verified"
    assert web.inserted[0][0] == "DNS_TXT"


def test_verify_failure_is_reported_not_raised():
    err = HttpError(type("R", (), {"status": 400, "reason": "Bad Request"})(), b"no txt")
    web = FakeWebResource(error=err)
    result = verification.verify(_client(web), "example.com")
    assert result.startswith("failed:")


def test_is_verified_returns_false_on_http_error():
    """is_verified returns False (not raises) when list().execute() raises HttpError."""
    class ErrorResource(FakeWebResource):
        def list(self):
            err = HttpError(type("R", (), {"status": 404, "reason": "Not Found"})(), b"not found")
            raise err

    web = ErrorResource()
    result = verification.is_verified(_client(web), "example.com")
    assert result is False


def test_is_verified_returns_false_on_unexpected_error():
    """is_verified returns False (not raises) when list().execute() raises non-HttpError exception."""
    class ErrorResource(FakeWebResource):
        def list(self):
            raise KeyError("unexpected")

    web = ErrorResource()
    result = verification.is_verified(_client(web), "example.com")
    assert result is False


def test_is_verified_returns_false_on_malformed_response():
    """is_verified returns False (not raises) when response has unexpected shape (items contains non-dict)."""
    class MalformedResource(FakeWebResource):
        def list(self):
            # items contains something that's not a dict (None), causing AttributeError
            # when parsing attempts item.get("site", {})
            return type("R", (), {"execute": lambda _s: {"items": [None]}})()

    web = MalformedResource()
    result = verification.is_verified(_client(web), "example.com")
    assert result is False
