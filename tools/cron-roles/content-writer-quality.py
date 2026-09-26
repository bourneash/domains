#!/usr/bin/env python3
"""Deterministic pre-commit quality gates for content-writer output.

This is intentionally site-agnostic: Astro's build remains the authoritative
schema check, while this gate catches cheap, explainable mistakes before the
build and before anything is staged.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

import yaml


BANNED = (
    "go big or go home",
    "perfect choice",
    "look no further",
    "game-changing",
    "revolutionary",
    "don't miss",
    "as an ai",
)
LINK_RE = re.compile(r"(?:\[[^\]]*\]\(|<a\b[^>]*\bhref\s*=\s*[\"'])([^\"')> ]+)", re.I)
GO_RE = re.compile(r"^/go/([^/?#]+)/?(?:[?#].*)?$")


def changed_paths(repo: Path) -> list[str]:
    commands = [
        ["git", "-C", str(repo), "diff", "--name-only", "HEAD", "--"],
        ["git", "-C", str(repo), "ls-files", "--others", "--exclude-standard", "--"],
    ]
    paths: set[str] = set()
    for command in commands:
        result = subprocess.run(command, check=True, capture_output=True, text=True)
        paths.update(line for line in result.stdout.splitlines() if line)
    return sorted(paths)


def frontmatter(path: Path) -> tuple[dict, str | None]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return {}, "missing YAML frontmatter fence"
    end = text.find("\n---", 4)
    if end < 0:
        return {}, "unterminated YAML frontmatter"
    try:
        data = yaml.safe_load(text[4:end]) or {}
    except yaml.YAMLError as exc:
        return {}, f"invalid YAML frontmatter: {exc}"
    if not isinstance(data, dict):
        return {}, "frontmatter must be a mapping"
    return data, None


def route_exists(repo: Path, target: str) -> bool:
    path = urlsplit(target).path
    if not path or path == "/":
        return True
    slug = path.strip("/")
    pages = repo / "site/src/pages"
    if (pages / f"{slug}.astro").exists() or (pages / slug / "index.astro").exists():
        return True
    parts = slug.split("/")
    if len(parts) == 2 and (repo / "site/src/content" / parts[0] / f"{parts[1]}.md").exists():
        return True
    return False


def affiliate_ids(repo: Path) -> set[str]:
    redirects = repo / "site/public/_redirects"
    if not redirects.exists():
        return set()
    return set(re.findall(r"^/go/([^/\s]+)", redirects.read_text(encoding="utf-8"), re.M))


def check_file(repo: Path, rel: str, errors: list[str]) -> None:
    path = repo / rel
    if not path.is_file() or path.suffix.lower() != ".md" or not rel.startswith("site/src/content/"):
        return
    data, error = frontmatter(path)
    if error:
        errors.append(f"{rel}: {error}")
        return

    collection = rel.split("/")[3]
    required = {
        "guides": {"title", "description", "technique", "updated"},
        "species": {"name", "description", "waterType", "range", "tackleClass", "updated"},
        "gear": {"title", "description", "category", "updated"},
        "kits": {"title", "description", "components", "updated"},
    }.get(collection, set())
    for key in sorted(required - data.keys()):
        errors.append(f"{rel}: missing required frontmatter field '{key}'")
    if "updated" in data and (not isinstance(data["updated"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", data["updated"])):
        errors.append(f"{rel}: updated must be YYYY-MM-DD")
    if isinstance(data.get("updated"), str):
        try:
            date.fromisoformat(data["updated"])
        except ValueError:
            errors.append(f"{rel}: updated is not a real calendar date")

    hero = data.get("heroImage")
    if isinstance(hero, str) and hero.startswith("/") and not (repo / "site/public" / hero.lstrip("/")).exists():
        errors.append(f"{rel}: heroImage does not exist: {hero}")

    ids = affiliate_ids(repo)
    for key in ("featuredProducts", "productIds", "components"):
        values = data.get(key, [])
        if isinstance(values, list):
            for value in values:
                if isinstance(value, str) and value not in ids:
                    errors.append(f"{rel}: {key} references unknown affiliate id '{value}'")

    text = path.read_text(encoding="utf-8")
    lowered = text.lower()
    for phrase in BANNED:
        if phrase in lowered:
            errors.append(f"{rel}: banned phrase: {phrase}")
    if "—" in text:
        errors.append(f"{rel}: em dash is forbidden in published content")

    for target in LINK_RE.findall(text):
        if target.startswith(("http:", "https:", "mailto:", "tel:", "#", "javascript:")):
            continue
        match = GO_RE.match(target)
        if match:
            if match.group(1) not in ids:
                errors.append(f"{rel}: unknown affiliate link: {target}")
        elif target.startswith("/") and not route_exists(repo, target):
            errors.append(f"{rel}: internal link does not resolve: {target}")


def check_duplicate_titles(repo: Path, changed: set[str], errors: list[str]) -> None:
    seen: dict[str, str] = {}
    for path in sorted((repo / "site/src/content").glob("*/*.md")):
        data, error = frontmatter(path)
        if error:
            continue
        title = data.get("title") or data.get("name")
        if not isinstance(title, str) or not title.strip():
            continue
        rel = path.relative_to(repo).as_posix()
        previous = seen.get(title.casefold())
        if previous and (rel in changed or previous in changed):
            errors.append(f"{rel}: duplicate content title also used by {previous}: {title}")
        else:
            seen[title.casefold()] = rel


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, required=True)
    args = parser.parse_args()
    errors: list[str] = []
    try:
        paths = changed_paths(args.repo_root)
        for rel in paths:
            check_file(args.repo_root, rel, errors)
        check_duplicate_titles(args.repo_root, set(paths), errors)
    except (OSError, subprocess.CalledProcessError, yaml.YAMLError) as exc:
        print(f"[content-quality] unable to run checks: {exc}", file=sys.stderr)
        return 2
    if errors:
        print("[content-quality] FAILED", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"[content-quality] passed ({len(paths)} changed path(s) inspected)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
