---
name: unsloth
description: Fine-tune and chat with open models on an AMD GPU with Unsloth Studio (ROCm) — open Studio and the notebooks, share the GPU with running models, export a result to the Model Catalog
triggers:
  - unsloth
  - fine-tune
  - fine tune a model
  - finetune
  - train a lora
  - qlora
  - unsloth studio
tools:
  - crow-memory
---

# Unsloth Studio (AMD ROCm)

## When to activate

- The user wants to fine-tune (LoRA / QLoRA) or train an open model on this machine.
- The user mentions Unsloth, Unsloth Studio, or the Unsloth notebooks.
- The user asks how to turn a fine-tuned model into something Crow can chat with.

## What it is

Unsloth is a fine-tuning library that trains open models (Llama, Qwen, Gemma, gpt-oss and others) with less memory. This extension runs **`unsloth/unsloth-rocm`**, Unsloth's build for AMD GPUs, with two web apps:

| App | Address (this machine only) | Login |
|---|---|---|
| Unsloth Studio (training and chat UI) | `http://localhost:3075/` | user `unsloth`, password in Settings → Passwords ("Studio admin password") |
| JupyterLab with the Unsloth notebooks (the `AMD-*` set first) | `http://localhost:3076/` | password in Settings → Passwords ("JupyterLab password") |

Both listen on 127.0.0.1 only. At install Crow also serves Studio over HTTPS on the private tailnet (Tailscale Serve on port 3075, never Funnel), so the Studio tile opens from the user's other devices, behind Studio's own login. JupyterLab has no tile and no tailnet route. Its password sits in the container environment, so code run inside Studio or a notebook can read it (both already run as root in the same container). Never set up a public tunnel or Funnel to either.

## Hardware

- **AMD ROCm GPUs only** (RDNA2 and newer, CDNA). Crow refuses the install on NVIDIA or CPU-only machines. The plain `unsloth/unsloth` image is CUDA-only and is not used. The Steam Deck GPU (gfx1033) is refused by the image itself.
- **Strix Halo (gfx1151):** upstream measured LoRA training and diffusion on it with this image's generic ROCm wheels. AMD's per-architecture wheels fix a crash in grouped matrix multiplies on gfx1151. If a mixture-of-experts run crashes there, the fix is to rebuild with `ROCM_GFX=gfx1151` (Unsloth's `docker/build.sh --rocm`). It isn't a performance tweak.
- GGUF chat inside Studio runs on the CPU in this release. Training, the notebooks and the UI use the GPU.

## Sharing the GPU

A training run can take most of the GPU and memory for minutes to hours. Models already served on this machine (chat, voice) slow down, or fail to start, while it runs. Before a long run:

1. Pick a quiet time, and tell anyone else who uses this Crow.
2. If the household keeps a schedule for GPU work, put the run on it.
3. Stop the extension from the Extensions page when you are done. An idle Studio holds little GPU memory, but a loaded model in a notebook holds all of it until the kernel stops.

## From fine-tune to Crow chat

1. In Studio or a notebook, export the trained model as **GGUF** (or merged safetensors).
2. Copy the file out of the container. Outputs live in the `unsloth-workspace` / `unsloth-studio` Docker volumes, e.g. `docker cp crow-unsloth:/workspace/<path>/model.gguf ./`.
3. Add it to the Model Catalog, which serves it like any other local model.

Crow doesn't register Studio itself as a chat provider. Its chat is internal to Studio, behind Studio's own login.

## Gated models

For Llama or Gemma checkpoints that need a Hugging Face login, set **UNSLOTH_HF_TOKEN** in the extension's settings and restart it.

## Troubleshooting

- **Studio not up yet:** the first start downloads about 17 GB and loads PyTorch. The health check allows 10 minutes. Watch the container log.
- **"/dev/kfd not found" in the log:** the host has no AMD ROCm driver loaded (`ls /dev/kfd` on the host).
- **Bus error in a notebook data loader:** raise **UNSLOTH_SHM_SIZE** (Advanced settings) and restart.
- **Forgot the Studio password after changing it:** `docker exec -it crow-unsloth unsloth studio reset-password`.
- **Studio page doesn't load but JupyterLab does:** Studio refused to start (its log says why); restart the extension.

## Licences

- Unsloth library: **Apache-2.0**. Its `unsloth-zoo` helper: **LGPL-3.0-or-later**.
- Unsloth Studio (the web UI in this image): **AGPL-3.0**. The image enforces its attribution notices ("Built by the Unsloth team", the About dialog), and they must stay visible.
- Crow runs the unmodified upstream image in its own container and links none of its code. If this Crow is ever offered to other people over a network, Studio's AGPL obligations apply to Studio (keep the notices, point to https://github.com/unslothai/unsloth). They don't extend to Crow.
