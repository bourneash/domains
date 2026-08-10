"""media-gen HTTP API — on-demand AI image generation for the whole fleet.

Mirrors tools/data-hub-images' shape on purpose (POST an ask, get back
{id, url, credit}; GET the bytes by id) so a site that already knows how to
talk to the stock-photo broker can add this as a second call with almost no
new mental model. The difference: data-hub-images *fetches* real photos from
external providers behind a VPN; this *generates* original images locally
(ComfyUI, default/fast) or via a real browser session (Nano Banana, opt-in/
slow) — it never touches the public internet on its own.

Run:
    uvicorn media_gen.api:app --host 127.0.0.1 --port 4780

See README.md for why this runs as a plain host process rather than in
Docker (both backends need host-local access — ComfyUI's GPU process,
Nano Banana's real browser window — that a container can't give them
cleanly), and for the host.docker.internal wiring site containers need.
"""
from __future__ import annotations

from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import comfyui, nanobanana, store

app = FastAPI(title="media-gen", version="0.1.0")


class GenerateRequest(BaseModel):
    site: str = Field(..., description="Consuming site key, e.g. '0daynews'. Stored for provenance only.")
    prompt: str = Field(..., min_length=3)
    negative_prompt: str | None = None
    backend: Literal["comfyui", "nanobanana"] = "comfyui"
    width: int = 1216
    height: int = 832
    steps: int = 4
    seed: int | None = None
    aspect_ratio: str = "3:2"  # nanobanana only — ComfyUI uses width/height directly
    slug: str | None = Field(None, description="Article/page slug, stored for provenance only.")


class GenerateResponse(BaseModel):
    id: str
    url: str
    backend: str
    width: int | None = None
    height: int | None = None
    credit: dict


@app.get("/health")
def health():
    return {
        "ok": True,
        "comfyui": {"reachable": comfyui.ping()},
        "nanobanana": {"available": nanobanana.available()},
    }


@app.get("/backends")
def backends():
    return {
        "comfyui": {
            "reachable": comfyui.ping(),
            "default": True,
            "speed": "seconds to ~1min, synchronous",
            "notes": "Local GPU generation (flux1-schnell). No browser, no external network.",
        },
        "nanobanana": {
            "available": nanobanana.available(),
            "default": False,
            "speed": "30s-4min, synchronous, opens a REAL VISIBLE BROWSER on the host",
            "notes": (
                "CloakBrowser + Gemini web UI. Fleet-wide serialized (one at a time via a "
                "shared profile lock) — expect 429s under contention, retry."
            ),
        },
    }


@app.post("/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest):
    if req.backend == "comfyui":
        try:
            image_bytes, meta = comfyui.generate(
                prompt=req.prompt, negative=req.negative_prompt,
                width=req.width, height=req.height, steps=req.steps, seed=req.seed,
            )
        except comfyui.ComfyUIError as e:
            raise HTTPException(status_code=503, detail=str(e)) from e
        ext = "png"
    else:
        try:
            image_bytes, meta = nanobanana.generate(req.prompt, aspect_ratio=req.aspect_ratio)
        except nanobanana.NanoBananaError as e:
            status = 429 if "already running" in str(e) else 503
            raise HTTPException(status_code=status, detail=str(e)) from e
        ext = "png"

    meta["site"] = req.site
    meta["slug"] = req.slug
    image_id = store.save(image_bytes, ext, meta)

    return GenerateResponse(
        id=image_id,
        url=f"/image/{image_id}",
        backend=meta["backend"],
        width=meta.get("width"),
        height=meta.get("height"),
        credit=meta["credit"],
    )


@app.get("/image/{image_id}")
def get_image(image_id: str):
    result = store.load_bytes(image_id)
    if result is None:
        raise HTTPException(status_code=404, detail="unknown image id")
    image_bytes, content_type = result
    return Response(content=image_bytes, media_type=content_type)


@app.get("/image/{image_id}/meta")
def get_image_meta(image_id: str):
    meta = store.load_meta(image_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="unknown image id")
    return meta
