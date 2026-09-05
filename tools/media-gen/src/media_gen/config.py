"""media-gen configuration — env-overridable, sane defaults for this host."""
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent  # tools/media-gen/

# ComfyUI itself runs in its own docker container (imageSetToCategories'
# GPU-passthrough comfyui service) that publishes 8188 to the host. This
# service's own container uses network_mode: host (see docker-compose.yml),
# so "localhost:8188" resolves the same way whether media-gen is running
# bare or in its container — no host.docker.internal indirection needed
# for this leg. Site cron containers still reach *this* service (port
# 4780) via host.docker.internal, same as always.
COMFYUI_URL = os.environ.get("MEDIA_GEN_COMFYUI_URL", "http://localhost:8188")

# Default checkpoint. flux1-schnell-fp8 is a single merged checkpoint (no
# separate UNETLoader/DualCLIPLoader wiring needed), 4-step, high quality,
# fast enough (~10-30s on this host's dual A4000s) to serve synchronously.
COMFYUI_CHECKPOINT = os.environ.get(
    "MEDIA_GEN_COMFYUI_CHECKPOINT", "flux1-schnell-fp8.safetensors"
)

# Opt-in quality profile. This is the FLUX Dev stack already installed on
# this host and used by the higher-fidelity direct renderer elsewhere.
COMFYUI_DEV_MODEL = os.environ.get(
    "MEDIA_GEN_COMFYUI_DEV_MODEL",
    "FLUX1/flux_dev_fp8_scaled_diffusion_model.safetensors",
)
COMFYUI_DEV_CLIP_L = os.environ.get("MEDIA_GEN_COMFYUI_DEV_CLIP_L", "clip_l.safetensors")
COMFYUI_DEV_T5 = os.environ.get("MEDIA_GEN_COMFYUI_DEV_T5", "t5xxl_fp16.safetensors")
COMFYUI_DEV_VAE = os.environ.get("MEDIA_GEN_COMFYUI_DEV_VAE", "flux_vae.safetensors")

# Where generated images + their sidecar metadata live. Flat directory,
# JSON-sidecar-per-image rather than a database — this service generates
# on the order of "one image per article," not a searchable stock library,
# so a directory scan is plenty and it's trivially inspectable/debuggable.
DATA_DIR = Path(os.environ.get("MEDIA_GEN_DATA_DIR", str(REPO_ROOT / "data")))

# CloakBrowser's shared profile is a single, fleet-wide serialization point
# (see domains-media-generator-nanobanana skill) — only one Nano Banana
# generation can run at a time across the WHOLE fleet, not just within this
# service. This lock file enforces that at the process level so two
# concurrent /generate requests (from this service or a manually-run skill
# elsewhere) queue instead of colliding and corrupting the browser profile.
NANOBANANA_LOCK_PATH = Path(
    os.environ.get("MEDIA_GEN_NANOBANANA_LOCK", "/tmp/media-gen-nanobanana.lock")
)

# The nanobanana skill's generator script + the python interpreter that has
# the `cloakbrowser` package installed (see that skill's SKILL.md).
NANOBANANA_SKILL_DIR = Path(
    os.environ.get(
        "MEDIA_GEN_NANOBANANA_SKILL_DIR",
        str(Path.home() / ".claude/skills/domains-media-generator-nanobanana"),
    )
)
NANOBANANA_PYTHON_CWD = Path(
    os.environ.get(
        "MEDIA_GEN_NANOBANANA_PYTHON_CWD",
        "/home/jesse/projects/domains/tools/social-setup",
    )
)
NANOBANANA_PYTHON = os.environ.get("MEDIA_GEN_NANOBANANA_PYTHON", "python3")

# Wall-clock budget for a single ComfyUI generation before we give up and
# return 504. Generous — a cold model load (first request after ComfyUI
# restarts) can take a while; steady-state is seconds.
COMFYUI_TIMEOUT_S = float(os.environ.get("MEDIA_GEN_COMFYUI_TIMEOUT_S", "300"))

# Nano Banana runs a real visible browser + waits on a Gemini web UI —
# minutes, not seconds, and occasionally flaky (see the skill's gotchas).
NANOBANANA_TIMEOUT_S = float(os.environ.get("MEDIA_GEN_NANOBANANA_TIMEOUT_S", "240"))
