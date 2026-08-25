"""Nothing in this suite may touch the real credential vault.

`social_lib.credentials` is a thin wrapper over `vault_store`, which shells out
to the `bw` CLI against the live Vaultwarden org collection. Several tests here
call `write_stub()` / `generate_and_store_totp()`, so on any machine where `bw`
is on PATH they were **writing "example.com — facebook/instagram/bluesky/reddit"
items into the production vault every time the suite ran** — and on a machine
without `bw` (a cron PATH of /usr/bin:/bin, for instance) they failed with
FileNotFoundError. Both symptoms, one cause.

This autouse fixture redirects the store into memory for every test in the
package, so neither can happen again.
"""

import pytest
from social_lib import vault_store


@pytest.fixture(autouse=True)
def fake_vault(monkeypatch):
    items: dict[tuple[str, str], dict] = {}

    def write_creds(domain, platform, data):
        items[(domain, platform)] = dict(data)

    def read_creds(domain, platform):
        return dict(items.get((domain, platform), {}))

    def has_creds(domain, platform):
        return (domain, platform) in items

    def write_stub(domain, platform):
        if not has_creds(domain, platform):
            write_creds(domain, platform, {"STATUS": "deferred"})

    for name, fn in (("write_creds", write_creds), ("read_creds", read_creds),
                     ("has_creds", has_creds), ("write_stub", write_stub)):
        monkeypatch.setattr(vault_store, name, fn)

    # Anything that slips past the wrappers and reaches the CLI directly is a
    # bug in the test, not something to paper over — make it loud.
    def _no_bw(*_a, **_k):
        raise AssertionError("test tried to invoke the `bw` CLI against the real vault")

    monkeypatch.setattr(vault_store, "_bw", _no_bw)
    monkeypatch.setattr(vault_store, "_ensure_unlocked", lambda: None)
    return items
