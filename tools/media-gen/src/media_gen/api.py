"""media-gen HTTP API — on-demand AI image generation for the whole fleet.

Mirrors tools/data-hub-images' shape on purpose (POST an ask, get back
{id, url, credit}; GET the bytes by id) so a site that already knows how to
talk to the stock-photo broker can add this as a second call with almost no
new mental model. The difference: data-hub-images *fetches* real photos from
external providers behind a VPN; this *generates* original images locally
(ComfyUI, default/fast) or via a real browser session (Nano Banana, opt-in/
slow) — it never touches the public internet on its own.

Run:
    uvicorn media_gen.api:app --host 0.0.0.0 --port 4780
    # (binds all interfaces; _RestrictToLocalAndDocker below is what
    # actually limits reachability to loopback + the docker0 bridge —
    # see that class's comment for why the bind address alone can't do
    # this correctly on a host with real LAN/VPN interfaces)

Runs in Docker (network_mode: host, restart: unless-stopped) — see
README.md's "Why this runs in Docker" for why, and for the
host.docker.internal wiring site containers need to reach it.
"""
from __future__ import annotations

import ipaddress
import time
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware

from . import comfyui, nanobanana, store

app = FastAPI(title="media-gen", version="0.1.0")

# This host has real, non-loopback interfaces (LAN, a VPN tunnel) beyond
# docker's bridges — binding uvicorn to 0.0.0.0 without this middleware
# would expose generation (and the ComfyUI/CloakBrowser machinery behind it)
# to whatever else can reach those networks, not just this host and its own
# containers. uvicorn can only bind one --host value, and the caller that
# actually needs this service (a site's cron/worker container, via
# host.docker.internal) arrives over WHICHEVER bridge that site's own
# `docker compose` project created — every project gets its own bridge
# (e.g. `reviewtattoo-ops_ops`, a distinct 172.x.x.0/24 subnet), not the
# literal default `docker0` bridge. An earlier version of this allowlist
# only trusted docker0 itself and 403'd every real per-project caller
# except a container on the default bridge — found + fixed 2026-08-10
# wiring the first real caller (reviewtattoo's guide-writer role, running
# in the `reviewtattoo-ops_ops` network, not docker0). Bind 0.0.0.0 and
# enforce the intended reachability here instead, by enumerating every
# Docker bridge interface on the host (docker0 + every project's `br-*`),
# not just one hardcoded name.


def _discover_docker_bridge_nets(ip_addr_output: str) -> list[ipaddress.IPv4Network]:
    """Parse `ip -4 -o addr show` output into every docker0/br-* bridge's
    subnet. Pulled out as a pure function (rather than inlined at import
    time) so it's directly unit-testable against captured `ip` output —
    see tests/test_middleware.py's br-* regression test.

    Lines look like: "3: docker0    inet 172.30.0.1/24 brd ..." or
    "7: br-a1b2c3d4e5f6    inet 172.30.65.1/24 brd ...". Docker names the
    default bridge "docker0" and every user-defined/compose-project bridge
    "br-<network-id>" — matching that prefix (plus the exact docker0 name)
    is how the daemon itself distinguishes "a docker bridge" from a LAN/VPN
    interface, without needing to shell out to `docker network ls` (which
    needs the socket mounted; this doesn't).
    """
    nets: list[ipaddress.IPv4Network] = []
    for line in ip_addr_output.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        iface = parts[1].rstrip(":")
        if iface != "docker0" and not iface.startswith("br-"):
            continue
        try:
            inet_idx = parts.index("inet")
        except ValueError:
            continue
        cidr = parts[inet_idx + 1]  # e.g. "172.30.65.1/24"
        try:
            nets.append(ipaddress.ip_network(cidr, strict=False))
        except ValueError:
            pass
    return nets


def _read_bridge_nets() -> list[ipaddress.IPv4Network]:
    """Ask the host which docker bridges exist RIGHT NOW."""
    try:
        import subprocess
        out = subprocess.run(
            ["ip", "-4", "-o", "addr", "show"], capture_output=True, text=True, timeout=2,
        ).stdout
        return _discover_docker_bridge_nets(out)
    except Exception:
        return []  # docker not present / ip unavailable — loopback-only is still correct


_ALLOWED_NETS = [ipaddress.ip_network("127.0.0.0/8")]
_ALLOWED_NETS.extend(_read_bridge_nets())

# Discovering bridges ONCE at import made the allowlist a snapshot of whatever
# docker networks existed when this process started. Every compose project gets
# its own `br-*` bridge on its own 172.x subnet, so any site whose stack was
# created — or recreated; `compose down` frees the subnet and `up` may take a
# different one — after this process booted got a hard 403 with no way back
# except an operator restarting media-gen. Found 2026-08-25: stinkyleftfoot.com's
# bridge was created two days after this process started, so its guide-writer
# silently shipped art-less drafts. Re-read the bridge table on a miss instead.
# This does NOT widen the policy — the answer still comes from the same
# docker0/br-* enumeration; it just stops the answer from going stale. Rate
# limited so an unauthorized caller can't spin the subprocess in a loop.
_REFRESH_INTERVAL_S = 30.0
_last_refresh = 0.0


def _refresh_allowed_nets() -> None:
    global _last_refresh
    now = time.monotonic()
    if now - _last_refresh < _REFRESH_INTERVAL_S:
        return
    _last_refresh = now
    for net in _read_bridge_nets():
        if net not in _ALLOWED_NETS:
            _ALLOWED_NETS.append(net)


class _RestrictToLocalAndDocker(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        client = request.client.host if request.client else None
        try:
            addr = ipaddress.ip_address(client)
        except (TypeError, ValueError):
            addr = None
        if addr is not None and not any(addr in net for net in _ALLOWED_NETS):
            # Could be a bridge that appeared after we booted — re-read the
            # table and re-check before rejecting.
            _refresh_allowed_nets()
        if addr is None or not any(addr in net for net in _ALLOWED_NETS):
            return JSONResponse(status_code=403, content={"detail": "forbidden — not host-local or docker0"})
        return await call_next(request)


app.add_middleware(_RestrictToLocalAndDocker)


class GenerateRequest(BaseModel):
    site: str = Field(..., description="Consuming site key, e.g. '0daynews'. Stored for provenance only.")
    prompt: str = Field(..., min_length=3)
    negative_prompt: str | None = None
    backend: Literal["comfyui", "nanobanana"] = "comfyui"
    width: int = 1216
    height: int = 832
    steps: int = 4
    seed: int | None = None
    profile: Literal["fast", "quality"] = "fast"
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
            "notes": (
                "Local GPU generation. profile=fast uses FLUX Schnell; "
                "profile=quality uses FLUX Dev at 30 steps. No browser or external network."
            ),
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
                profile=req.profile,
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
