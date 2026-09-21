"""Catch copied site-specific worker git identities before they reach Docker."""

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
GIT_STORE = re.compile(r"/git-store/([A-Za-z0-9.-]+)")


def test_git_store_paths_match_the_site_name():
    failures = []
    for entrypoint in sorted((ROOT / "sites").glob("*/ops/docker/entrypoint-worker.sh")):
        site = entrypoint.parents[2].name
        refs = sorted(set(GIT_STORE.findall(entrypoint.read_text(encoding="utf-8"))))
        if refs and refs != [site]:
            failures.append(f"{site}: entrypoint references {refs}")

        compose = entrypoint.parents[2] / "docker-compose.yml"
        if compose.exists():
            compose_refs = sorted(set(GIT_STORE.findall(compose.read_text(encoding="utf-8"))))
            if compose_refs and compose_refs != [site]:
                failures.append(f"{site}: compose references {compose_refs}")

    assert not failures, "\n".join(failures)
