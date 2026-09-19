import datetime
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "lib"))
import guide_queue  # noqa: E402
import cli  # noqa: E402


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


def test_image_status_requires_safe_nontrivial_files(tmp_path: Path) -> None:
    _write_item(
        tmp_path,
        "drafted",
        "guide.md",
        "---\n"
        "queue_id: guide\n"
        "created: '2026-09-01'\n"
        "title: Guide\n"
        "hero_image: ops/guide-queue/drafted-assets/guide/hero.jpg\n"
        "card_image: ../../outside.webp\n"
        "---\n"
        "body\n",
    )
    hero = tmp_path / "ops/guide-queue/drafted-assets/guide/hero.jpg"
    hero.parent.mkdir(parents=True)
    hero.write_bytes(b"x" * 8_000)

    result = guide_queue.image_status(
        tmp_path, "drafted", "guide.md", ["hero_image", "card_image"]
    )

    assert result["ok"] is False
    assert result["missing"] == [{"field": "card_image", "reason": "outside-site-root"}]


def test_oldest_missing_images_prioritizes_ready_then_created(tmp_path: Path) -> None:
    for status, name, created, has_image in [
        ("drafted", "older.md", "2026-08-01", False),
        ("ready", "ready-complete.md", "2026-09-01", True),
        ("ready", "ready-missing.md", "2026-09-02", False),
    ]:
        image_line = "hero_image: ops/guide-queue/drafted-assets/shared/hero.jpg\n" if has_image else ""
        _write_item(
            tmp_path,
            status,
            name,
            "---\n"
            f"queue_id: {name[:-3]}\n"
            f"created: '{created}'\n"
            f"title: {name}\n"
            f"{image_line}"
            "---\n"
            "body\n",
        )
    hero = tmp_path / "ops/guide-queue/drafted-assets/shared/hero.jpg"
    hero.parent.mkdir(parents=True)
    hero.write_bytes(b"x" * 8_000)

    result = guide_queue.oldest_missing_images(tmp_path, ["hero_image"])

    assert result is not None
    assert result["status"] == "ready"
    assert result["file"] == "ready-missing.md"


def test_oldest_missing_images_returns_none_when_art_is_complete(tmp_path: Path) -> None:
    _write_item(
        tmp_path,
        "drafted",
        "guide.md",
        "---\n"
        "queue_id: guide\n"
        "created: '2026-09-01'\n"
        "title: Guide\n"
        "hero_image: ops/guide-queue/drafted-assets/guide/hero.jpg\n"
        "---\n"
        "body\n",
    )
    hero = tmp_path / "ops/guide-queue/drafted-assets/guide/hero.jpg"
    hero.parent.mkdir(parents=True)
    hero.write_bytes(b"x" * 8_000)

    assert guide_queue.oldest_missing_images(tmp_path, ["hero_image"]) is None


def test_cli_json_output_serializes_yaml_dates(capsys) -> None:
    cli._out({"published": datetime.date(2026, 9, 8)})
    assert json.loads(capsys.readouterr().out) == {"published": "2026-09-08"}
