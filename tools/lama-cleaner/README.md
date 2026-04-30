# lama-cleaner

Local launcher for **IOPaint** (the maintained successor to `lama-cleaner`, by the same author). Spins up the web UI bound to your LAN, GPU-accelerated, pointed at a directory of your images.

## One-time setup

```bash
cd /home/jesse/projects/domains/tools/lama-cleaner
./setup.sh
```

This will:
- clone `Sanster/IOPaint` into `iopaint-src/`
- create `.venv/` with PyTorch + CUDA 12.1 wheels
- install IOPaint editable from the clone
- pre-download the `lama` model

Override the torch index if needed: `TORCH_INDEX=https://download.pytorch.org/whl/cu118 ./setup.sh`

## Use

```bash
./lama-cleaner /path/to/images
```

Prints something like:

```
  input    /path/to/images
  model    lama
  device   cuda
  local    http://127.0.0.1:54231
  LAN      http://192.168.1.42:54231
```

Open either URL — IOPaint will browse the directory you passed in.

### Flags

| flag | default | notes |
|------|---------|-------|
| `--output-dir` | same as `input_dir` | where edited images are written (in-place by default) |
| `--model` | `lama` | any IOPaint model: `ldm`, `zits`, `mat`, `fcf`, `manga`, `cv2`, etc. |
| `--device` | `cuda` | use `cpu` to force CPU |
| `--port` | random | pin to a fixed port |
| `--host` | `0.0.0.0` | bind to `127.0.0.1` to keep it local-only |
| `--gpu` | both | sets `CUDA_VISIBLE_DEVICES` (e.g. `--gpu 0`) |

Anything after the known flags is passed straight through to `iopaint start` — e.g. `./lama-cleaner /imgs --low-mem`.

## Models

Pre-downloaded by `setup.sh`: `lama`. To pull others:

```bash
.venv/bin/iopaint download --model ldm
.venv/bin/iopaint list
```

Models are cached under `~/.cache/torch/hub/` and `~/.cache/huggingface/`.

## Troubleshooting

- **`nvidia-smi` not found / `device=cuda` errors:** GPU drivers aren't loaded. Fall back with `--device cpu`.
- **Wrong CUDA wheels:** rerun setup with a different `TORCH_INDEX` (cu118, cu124, etc.).
- **Port already in use:** the launcher picks a random free port by default; if you pinned one, drop `--port`.
