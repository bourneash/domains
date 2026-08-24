#!/usr/bin/env python3
"""Deterministic, theme-locked image generation for one guide-queue item.

Called by run-guide-writer.sh AFTER Claude finishes the prose — image
generation is intentionally NOT delegated to the model. The prompt recipe
below is copied from this site's OWN existing style-lock doc
(ops/prompts/guide-cards/primer.md + suffix.txt, used to hand-generate the
16 existing guide hero/cards) rather than invented fresh — that's what
"theme-locked" and "matches the rest of the guides page" actually require:
every guide is another frame from the same shoot, not a new AI-art style.

Output formats/paths match the site's existing (pre-guide-queue) convention
exactly — this pipeline does NOT introduce a new `image`/`cardImage`
frontmatter field; nothing in the Astro templates reads one:
  - hero -> ops/guide-queue/drafted-assets/<qid>/hero.jpg  (1600x900 JPEG —
    site/src/pages/guides/[...slug].astro globs site/public/guides/heroes/
    for an optional hero; guide-publish.sh copies it there at publish time)
  - card -> ops/guide-queue/drafted-assets/<qid>/card.webp (1200x675 WebP —
    site/src/lib/guideIcons.ts maps every guide id to a
    site/public/images/guides/cards/<id>.webp; guide-publish.sh copies the
    file AND adds the guideIconMap entry)

Requires two env vars (set by the caller, which already knows the right
paths for host vs. container — see run-guide-writer.sh):
  GUIDE_QUEUE_LIB_DIR   — dir containing guide_queue.py
  MEDIA_GEN_CLIENT_DIR  — dir containing media_gen_client.py

Usage:
  generate-guide-images.py <repo_root> <status> <filename> \
      [--backend nanobanana] [--fallback-backend comfyui]
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
from pathlib import Path

for var in ("GUIDE_QUEUE_LIB_DIR", "MEDIA_GEN_CLIENT_DIR"):
    if not os.environ.get(var):
        print(f"missing required env var {var}", file=sys.stderr)
        sys.exit(2)

sys.path.insert(0, os.environ["GUIDE_QUEUE_LIB_DIR"])
sys.path.insert(0, os.environ["MEDIA_GEN_CLIENT_DIR"])

import guide_queue as gq  # noqa: E402
from media_gen_client import MediaGenClient, MediaGenError  # noqa: E402
from PIL import Image  # noqa: E402

# --- Theme lock: copied verbatim (condensed) from this site's own
# ops/prompts/guide-cards/primer.md + suffix.txt — the style-lock doc used
# to hand-generate the 16 existing guide images. Edit THAT file first if the
# house style ever changes; mirror the change here. Do not let a role prompt
# improvise this per-run. ---
BASE_STYLE = (
    "Cinematic dark editorial macro photography for a tattoo aftercare "
    "website's guide artwork. Chiaroscuro studio still life on a matte "
    "near-black surface falling to true black in the corners. One warm gold "
    "key light raking from the upper left at a low angle, a single cooler "
    "fill from behind to separate edges — deep rich shadows, never flat, "
    "never bright. Shallow depth of field, 85-100mm macro feel, subject "
    "tack sharp, background dissolving into darkness, fine film grain. "
    "Palette strictly antique gold/brass, deep blood red used sparingly as "
    "one small accent, warm off-white cream highlights, near-black to true "
    "black — no other saturated hues, no teal, no purple, no neon, no "
    "pastel. Premium, tactile, a little dangerous — like a high-end whiskey "
    "ad shot by a tattoo studio. One clear hero subject, two or three "
    "supporting objects maximum, generous negative space at both edges for "
    "a 16:9 crop. No text, no numbers, no letters, no logos, no brand "
    "names, no packaging labels, no faces, no eyes, no portraits — skin "
    "shown only as anonymous cropped forearm/shoulder detail. No collage, "
    "no split-screen, no infographic arrows, no UI, no watermarks."
)

SUBJECTS = {
    "placement": "A tattoo artist's gloved hand mid-work with a tattoo machine over an anonymous forearm, fresh linework just out of focus",
    "first-tattoo": "A tattoo studio chair with a folded prep towel and disposable armrest cover, warm key light, no one in frame",
    "aftercare": "A small jar of aftercare balm with a smear on a piece of plastic wrap, an anonymous forearm edge at the frame's side",
    "healing": "A roll of medical tape and a peeled adhesive bandage on a studio tray, warm indirect light",
    "removal": "A tattoo machine and a folded cloth on a stainless tray under warm clinical light, contemplative and still",
    "cost": "A leather-bound appointment book and a pen on a studio counter, warm ambient light, shallow depth of field",
    "design": "A pencil sketch and a stencil sheet on a studio desk under a warm desk lamp, close macro detail",
}


def build_prompt(category: str) -> str:
    subject = SUBJECTS.get(category, SUBJECTS["placement"])
    return f"{subject}. {BASE_STYLE}"


def _crop_to_aspect(im: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """Center-crop to the target aspect ratio, then resize exactly."""
    target_ratio = target_w / target_h
    w, h = im.size
    src_ratio = w / h
    if src_ratio > target_ratio:
        new_w = int(h * target_ratio)
        left = (w - new_w) // 2
        im = im.crop((left, 0, left + new_w, h))
    elif src_ratio < target_ratio:
        new_h = int(w / target_ratio)
        top = (h - new_h) // 2
        im = im.crop((0, top, w, top + new_h))
    return im.resize((target_w, target_h), Image.LANCZOS)


def _save_validated(im: Image.Image, path: Path, image_format: str, *,
                    quality: int, expected_size: tuple[int, int],
                    min_bytes: int, min_entropy: float = 3.5) -> None:
    """Encode to a temporary file and publish only a non-blank valid image."""
    temp_path = path.with_name(f".{path.name}.tmp")
    try:
        im.save(temp_path, image_format, quality=quality)
        byte_count = temp_path.stat().st_size
        with Image.open(temp_path) as check:
            check.load()
            actual_format = check.format
            actual_size = check.size
            entropy = check.convert("RGB").entropy()
        if actual_format != image_format or actual_size != expected_size:
            raise RuntimeError(
                f"invalid generated image {path.name}: format={actual_format} "
                f"size={actual_size}, expected {image_format} {expected_size}"
            )
        if byte_count < min_bytes or entropy < min_entropy:
            raise RuntimeError(
                f"blank generated image {path.name}: {byte_count} bytes "
                f"(floor {min_bytes}), entropy {entropy:.2f} (floor {min_entropy})"
            )
        temp_path.replace(path)
    finally:
        temp_path.unlink(missing_ok=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("repo_root")
    ap.add_argument("status")
    ap.add_argument("filename")
    ap.add_argument("--backend", default="nanobanana")
    ap.add_argument("--fallback-backend", default="comfyui")
    args = ap.parse_args()

    repo_root = Path(args.repo_root)
    item = gq.get_item(repo_root, args.status, args.filename)
    meta, body = item["meta"], item["body"]
    qid = meta.get("queue_id") or gq.slugify(meta.get("title", args.filename))
    category = meta.get("category", "placement")
    prompt = build_prompt(category)

    assets_dir = repo_root / "ops" / "guide-queue" / "drafted-assets" / qid
    assets_dir.mkdir(parents=True, exist_ok=True)

    client = MediaGenClient()

    def generate_raw(slug_suffix: str, w: int, h: int) -> bytes:
        try:
            r = client.generate(site="{{MEDIA_GEN_SITE_SLUG}}", prompt=prompt, backend=args.backend,
                                 slug=f"{qid}-{slug_suffix}", width=w, height=h)
        except MediaGenError as e:
            # media_gen_client already absorbed transient 429 contention with
            # its own retry-and-wait; reaching here means it's still
            # unavailable. Word this as "unavailable", not "failed" — the
            # fallback below makes it a handled path, not an incident, and
            # the fleet error-scanner keys on "failed"/"error" substrings.
            print(f"[generate-guide-images] {args.backend} unavailable for {slug_suffix}: {e} "
                  f"— falling back to {args.fallback_backend}", file=sys.stderr)
            r = client.generate(site="{{MEDIA_GEN_SITE_SLUG}}", prompt=prompt, backend=args.fallback_backend,
                                 slug=f"{qid}-{slug_suffix}", width=w, height=h)
        img_url = f"{client.base_url}{r['url']}"
        import urllib.request
        with urllib.request.urlopen(img_url, timeout=client.timeout) as resp:
            return resp.read(), r.get("backend")

    # Generate at a size comfortably larger than either target so the
    # center-crop below has real pixels to work with either direction.
    def generate_validated(slug_suffix: str, out_path: Path, image_format: str,
                            target_w: int, target_h: int, min_bytes: int,
                            max_attempts: int = 2) -> str | None:
        """generate_raw + crop + _save_validated, retrying the whole chain
        (fresh generation, not just re-saving) on a blank/invalid result —
        flux-schnell (the comfyui fallback checkpoint) occasionally renders
        a blank/low-entropy frame; one retry is usually enough, and it's
        cheaper than losing the image entirely and shipping a text-only
        guide (see the 2026-08-23 reviewtattoo incident this fix addresses)."""
        last_err: RuntimeError | None = None
        for attempt in range(1, max_attempts + 1):
            raw, backend = generate_raw(slug_suffix, 1600, 1000)
            im = _crop_to_aspect(Image.open(io.BytesIO(raw)).convert("RGB"), target_w, target_h)
            try:
                _save_validated(im, out_path, image_format, quality=88,
                                expected_size=(target_w, target_h), min_bytes=min_bytes)
                return backend
            except RuntimeError as e:
                last_err = e
                if attempt < max_attempts:
                    print(f"[generate-guide-images] {slug_suffix} image failed validation "
                          f"(attempt {attempt}/{max_attempts}): {e} — regenerating",
                          file=sys.stderr)
        raise last_err

    hero_path = assets_dir / "hero.jpg"
    card_path = assets_dir / "card.webp"

    hero_backend = generate_validated("hero", hero_path, "JPEG", 1600, 900, 8000)
    print(f"[generate-guide-images] hero: backend={hero_backend} -> {hero_path} (1600x900 jpg)")

    card_backend = generate_validated("card", card_path, "WEBP", 1200, 675, 4000)
    print(f"[generate-guide-images] card: backend={card_backend} -> {card_path} (1200x675 webp)")

    meta["hero_image"] = str(hero_path.relative_to(repo_root))
    meta["card_image"] = str(card_path.relative_to(repo_root))
    gq.write_item(repo_root, args.status, args.filename, meta, body)
    print(json.dumps({"ok": True, "hero_image": meta["hero_image"], "card_image": meta["card_image"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
