#!/usr/bin/env bash
# One-time setup: clone IOPaint (the maintained successor to lama-cleaner),
# build a CUDA-enabled venv, and pre-fetch the lama model.
set -euo pipefail

cd "$(dirname "$0")"

REPO_URL="https://github.com/Sanster/IOPaint.git"
REPO_DIR="iopaint-src"
VENV=".venv"
TORCH_INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/cu121}"

if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 not found on PATH" >&2
    exit 1
fi

if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "WARNING: nvidia-smi not found — GPU may be unavailable. Continuing anyway." >&2
fi

if [ ! -d "$REPO_DIR" ]; then
    echo "==> Cloning IOPaint into $REPO_DIR ..."
    git clone --depth 1 "$REPO_URL" "$REPO_DIR"
else
    echo "==> $REPO_DIR already exists; pulling latest"
    git -C "$REPO_DIR" pull --ff-only || echo "   (pull failed, continuing with existing checkout)"
fi

if [ ! -d "$VENV" ]; then
    echo "==> Creating venv at $VENV"
    python3 -m venv "$VENV"
fi

PIP="$VENV/bin/pip"
"$PIP" install --upgrade pip wheel setuptools

echo "==> Installing PyTorch with CUDA wheels ($TORCH_INDEX)"
"$PIP" install --index-url "$TORCH_INDEX" torch torchvision

echo "==> Installing IOPaint from PyPI (wheel ships prebuilt web_app/)"
"$PIP" install --upgrade iopaint

echo "==> Pre-downloading lama model"
"$VENV/bin/iopaint" download --model lama || echo "   (model download failed; will retry on first launch)"

echo
echo "Setup complete."
echo "Launch with:  ./lama-cleaner /path/to/image/dir"
