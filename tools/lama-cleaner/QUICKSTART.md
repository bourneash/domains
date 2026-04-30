# lama-cleaner — Quickstart

Local launcher for **IOPaint** (the maintained successor to `lama-cleaner`, by the same author). GPU-accelerated, points at a directory of your images, prints a URL.

## 1. One-time setup

```bash
cd /home/jesse/projects/domains/tools/lama-cleaner
./setup.sh
```

This will:
- clone `Sanster/IOPaint` into `iopaint-src/` (kept for reference; not used at runtime)
- create `.venv/` with PyTorch + CUDA 12.1 wheels
- `pip install iopaint` from PyPI (the wheel ships the prebuilt `web_app/` — installing editable from the clone fails because the frontend isn't built)
- pre-download the `lama` model into `~/.cache/torch/hub/checkpoints/`

Override the torch index if you need a different CUDA: `TORCH_INDEX=https://download.pytorch.org/whl/cu118 ./setup.sh`

## 2. Run

```bash
./lama-cleaner /path/to/images
```

You'll see something like:

```
  IOPaint / lama-cleaner
  --------------------------------------------------------
  input    /path/to/images
  output   /path/to/images
  model    lama
  device   cuda
  local    http://127.0.0.1:54231
  LAN      http://10.18.18.20:54231

  Open one of the URLs above in your browser.
  Ctrl-C here to stop the server.
```

Open either URL. Edits are saved back to the input directory by default.

## 3. Flags

| flag | default | notes |
|------|---------|-------|
| `--output-dir` | same as `input_dir` | where edited images are written (in-place by default) |
| `--model` | `lama` | any IOPaint model: `ldm`, `zits`, `mat`, `fcf`, `manga`, `cv2`, etc. |
| `--device` | `cuda` | `cpu` to force CPU, `mps` on Apple |
| `--port` | random free | pin to a fixed port |
| `--host` | `0.0.0.0` | use `127.0.0.1` to keep it local-only |
| `--gpu` | both | sets `CUDA_VISIBLE_DEVICES` (e.g. `--gpu 0` to pin to one A4000) |

Anything after the known flags is passed straight through to `iopaint start` — e.g. `./lama-cleaner /imgs --low-mem`.

## 4. Models

`setup.sh` pre-downloads `lama`. To pull others:

```bash
.venv/bin/iopaint download --model ldm
.venv/bin/iopaint list
```

Cached under `~/.cache/torch/hub/` and `~/.cache/huggingface/`.

## 5. Examples

```bash
# in-place edits, default lama on cuda
./lama-cleaner /mnt/encrypted/training/Action_Making_bed

# write edits to a sibling directory, pin to GPU 1
./lama-cleaner /mnt/in --output-dir /mnt/out --gpu 1

# fixed port for bookmarking
./lama-cleaner /mnt/in --port 8080

# CPU fallback if drivers are wedged
./lama-cleaner /mnt/in --device cpu
```

## 6. Troubleshooting

- **`Directory '.../web_app' does not exist`** — you're running an editable install from the clone. The frontend isn't pre-built in the repo; `setup.sh` installs from the PyPI wheel instead. Re-run `./setup.sh`.
- **`--output-dir must be set when --input is a directory`** — old launcher. The launcher now passes `--output-dir` (defaulting to the input dir).
- **`nvidia-smi` not found / `device=cuda` errors** — drivers aren't loaded. Use `--device cpu`.
- **Wrong CUDA wheels** — rerun setup with a different `TORCH_INDEX` (cu118, cu124, etc.).
- **Port already in use** — drop `--port` so the launcher picks a random free one.

## 7. Files

```
lama-cleaner/
├── setup.sh         # one-time install
├── lama-cleaner     # launcher (Python, executable)
├── README.md        # short overview
├── QUICKSTART.md    # this file
├── .gitignore
├── .venv/           # gitignored, created by setup.sh
└── iopaint-src/     # gitignored, cloned by setup.sh (reference only)
```
