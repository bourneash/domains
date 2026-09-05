"""ComfyUI backend — synchronous txt2img over ComfyUI's native HTTP API.

No workflow files, no CLI subprocess: this submits the API-format graph
directly to POST /prompt, polls GET /history/{id}, and downloads the result
from GET /view. That's the whole ComfyUI HTTP contract for a plain txt2img
job (see the comfyui-studio skill for the fuller picture — LoRAs, img2img,
video — this module only needs the txt2img slice of it).

Default checkpoint is flux1-schnell-fp8.safetensors: a single merged
checkpoint (loads via plain CheckpointLoaderSimple, no separate UNETLoader/
DualCLIPLoader/VAELoader wiring), 4 sampling steps, and on this host's dual
A4000s a generation lands in seconds to low tens-of-seconds — fast enough to
serve inline within one HTTP request rather than needing a job queue.
"""
from __future__ import annotations

import time
import uuid

import httpx

from . import config

_NEGATIVE_DEFAULT = (
    "lowres, blurry, watermark, text, letters, words, caption, logo, signature, "
    "extra limbs, deformed, jpeg artifacts, oversaturated"
)

# GOTCHA, learned the hard way while building this: flux1-schnell is a
# guidance-distilled model and this workflow runs it at cfg=1.0 (required —
# raising cfg on schnell degrades quality badly, it wasn't trained for real
# classifier-free guidance). At cfg=1.0 the KSampler's negative conditioning
# has NO effect — it's mathematically inert, not just "weak." The
# _NEGATIVE_DEFAULT above is still passed through (harmless, and other
# checkpoints/backends may honor it) but don't trust it to suppress
# anything on the flux path. The thing that actually worked to stop the
# model rendering headline-style text on every image: dropping words like
# "cover", "headline", "editorial", "magazine", or the site's own name from
# the POSITIVE prompt — flux reads that framing as "this is a poster, add a
# title" and does, regardless of what the negative prompt forbids. Describe
# the visual scene itself; don't describe the artifact it's going into.


class ComfyUIError(RuntimeError):
    pass


def _fast_workflow(prompt: str, negative: str, width: int, height: int, steps: int, seed: int) -> dict:
    return {
        "4": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": config.COMFYUI_CHECKPOINT}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["4", 1]}},
        "10": {"class_type": "FluxGuidance", "inputs": {"conditioning": ["6", 0], "guidance": 3.5}},
        "5": {"class_type": "EmptySD3LatentImage",
              "inputs": {"width": width, "height": height, "batch_size": 1}},
        "3": {"class_type": "KSampler",
              "inputs": {"seed": seed, "steps": steps, "cfg": 1.0, "sampler_name": "euler",
                         "scheduler": "simple", "denoise": 1.0, "model": ["4", 0],
                         "positive": ["10", 0], "negative": ["7", 0], "latent_image": ["5", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage",
              "inputs": {"filename_prefix": "media-gen", "images": ["8", 0]}},
    }


def _quality_workflow(prompt: str, width: int, height: int, steps: int, seed: int) -> dict:
    """FLUX Dev graph for callers that value prompt fidelity over latency."""
    return {
        "1": {"class_type": "UNETLoader", "inputs": {
            "unet_name": config.COMFYUI_DEV_MODEL, "weight_dtype": "fp8_e4m3fn",
        }},
        "2": {"class_type": "DualCLIPLoader", "inputs": {
            "clip_name1": config.COMFYUI_DEV_CLIP_L,
            "clip_name2": config.COMFYUI_DEV_T5,
            "type": "flux",
        }},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": config.COMFYUI_DEV_VAE}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["2", 0]}},
        "6": {"class_type": "FluxGuidance", "inputs": {"conditioning": ["4", 0], "guidance": 3.2}},
        "7": {"class_type": "EmptyLatentImage", "inputs": {
            "width": width, "height": height, "batch_size": 1,
        }},
        "8": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": steps, "cfg": 1.0, "sampler_name": "euler",
            "scheduler": "simple", "denoise": 1.0, "model": ["1", 0],
            "positive": ["6", 0], "negative": ["5", 0], "latent_image": ["7", 0],
        }},
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
        "10": {"class_type": "SaveImage", "inputs": {
            "filename_prefix": "media-gen-quality", "images": ["9", 0],
        }},
    }


def ping() -> bool:
    try:
        r = httpx.get(f"{config.COMFYUI_URL}/system_stats", timeout=5)
        return r.status_code == 200
    except httpx.HTTPError:
        return False


def generate(
    prompt: str,
    negative: str | None = None,
    width: int = 1216,
    height: int = 832,
    steps: int = 4,
    seed: int | None = None,
    profile: str = "fast",
) -> tuple[bytes, dict]:
    """Generate one image. Returns (png_bytes, meta_dict). Raises ComfyUIError."""
    seed = seed if seed is not None else uuid.uuid4().int & 0xFFFFFFFF
    negative = negative or _NEGATIVE_DEFAULT
    if profile == "quality":
        steps = 30 if steps == 4 else steps
        workflow = _quality_workflow(prompt, width, height, steps, seed)
        checkpoint = config.COMFYUI_DEV_MODEL
        output_node = "10"
    else:
        workflow = _fast_workflow(prompt, negative, width, height, steps, seed)
        checkpoint = config.COMFYUI_CHECKPOINT
        output_node = "9"
    client_id = uuid.uuid4().hex

    with httpx.Client(timeout=30) as client:
        try:
            r = client.post(f"{config.COMFYUI_URL}/prompt",
                             json={"prompt": workflow, "client_id": client_id})
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise ComfyUIError(f"ComfyUI unreachable or rejected the job: {e}") from e

        body = r.json()
        if body.get("node_errors"):
            raise ComfyUIError(f"ComfyUI rejected the workflow: {body['node_errors']}")
        prompt_id = body["prompt_id"]

        deadline = time.monotonic() + config.COMFYUI_TIMEOUT_S
        history = None
        while time.monotonic() < deadline:
            hr = client.get(f"{config.COMFYUI_URL}/history/{prompt_id}", timeout=10)
            if hr.status_code == 200:
                data = hr.json()
                if prompt_id in data:
                    history = data[prompt_id]
                    break
            time.sleep(1.5)

        if history is None:
            raise ComfyUIError(
                f"timed out after {config.COMFYUI_TIMEOUT_S}s waiting for ComfyUI "
                f"(prompt_id={prompt_id}) — check the ComfyUI queue isn't backed up"
            )

        status = history.get("status", {})
        if status.get("status_str") == "error":
            raise ComfyUIError(f"ComfyUI job errored: {status}")

        images = history.get("outputs", {}).get(output_node, {}).get("images") or []
        if not images:
            raise ComfyUIError(f"ComfyUI finished with no output image: {history}")

        img_ref = images[0]
        vr = client.get(f"{config.COMFYUI_URL}/view", params={
            "filename": img_ref["filename"], "subfolder": img_ref.get("subfolder", ""),
            "type": img_ref.get("type", "output"),
        }, timeout=30)
        vr.raise_for_status()

    meta = {
        "backend": "comfyui",
        "checkpoint": checkpoint,
        "profile": profile,
        "prompt": prompt,
        "negative_prompt": negative,
        "width": width, "height": height, "steps": steps, "seed": seed,
        "credit": {
            "source": f"Media Gen (ComfyUI / {checkpoint})",
            "photographer": "AI-generated — no human photographer",
            "license": "Generated on this host — site-owned, no external license",
            "url": "",
        },
    }
    return vr.content, meta
