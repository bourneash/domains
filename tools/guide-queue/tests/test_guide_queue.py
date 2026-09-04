from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "lib"))
import guide_queue  # noqa: E402


def _write_item(root: Path, status: str, name: str, contents: str) -> None:
    path = root / "ops" / "guide-queue" / status / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")


def test_oldest_skips_corrupt_frontmatter(tmp_path: Path) -> None:
    _write_item(
        tmp_path,
        "drafted",
        "2026-corrupt.md",
        "---\n"
        "title: Broken: unquoted value\n"
        "---\n"
        "body\n",
    )
    _write_item(
        tmp_path,
        "drafted",
        "2026-valid.md",
        "---\n"
        "created: '2026-09-01'\n"
        "title: Valid draft\n"
        "---\n"
        "body\n",
    )

    candidate = guide_queue.oldest(tmp_path, "drafted")

    assert candidate is not None
    assert candidate["file"] == "2026-valid.md"


def test_list_status_surfaces_corrupt_frontmatter(tmp_path: Path) -> None:
    _write_item(
        tmp_path,
        "drafted",
        "broken.md",
        "---\n"
        "title: Broken: unquoted value\n"
        "---\n"
        "body\n",
    )

    items = guide_queue.list_status(tmp_path, "drafted")

    assert items[0]["file"] == "broken.md"
    assert "parse_error" in items[0]
