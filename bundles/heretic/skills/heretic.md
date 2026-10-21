---
name: heretic
description: Heretic, the optional refusal-removal (abliteration) tool — what it does to a model, the owner's responsibility, how to run it in its container, and its AGPL licence
triggers:
  - heretic
  - abliteration
  - abliterate
  - uncensor a model
  - remove refusals
tools:
  - crow-memory
---

# Heretic (refusal removal)

## When to activate

- The user names Heretic, or asks to "abliterate" or "uncensor" a model they have.
- The user asks what the Heretic extension does before installing it.

## What it does, plainly

Heretic removes a model's **safety refusals**. For a transformer language model, it computes the direction in the model's internal activations that separates prompts the model refuses from prompts it answers. Then it projects that direction out of the attention and MLP weights (directional ablation, "abliteration", Arditi et al. 2024). An automatic Optuna search tunes the ablation to minimise two things together: refusals, and drift from the original model (KL divergence). The result is a saved copy of the model that answers requests the original would refuse, **including harmful ones**, while keeping most of its other abilities.

Say this to the user before helping them run it:

- The safety behaviour the model's makers trained in is gone from the copy. What the copy says or does, and who it is shared with, is the owner's responsibility.
- The source model's own licence still applies to the copy. Some model licences forbid removing safety measures or particular uses: check before publishing a result.
- Heretic doesn't touch any model Crow is already serving. It writes a new copy.

## Running it

Heretic is a command-line tool with interactive prompts. The extension runs an idle container, `crow-heretic`, and the owner opens a terminal on the host:

```bash
docker exec -it crow-heretic heretic <huggingface-model-id>
# e.g. docker exec -it crow-heretic heretic Qwen/Qwen3-4B-Instruct-2507
```

- It benchmarks a batch size, runs the optimisation (tens of minutes to hours, GPU-heavy), then asks which trial to keep and what to do with it.
- When it asks where to save, answer **`/models/<name>`**. That folder is the `heretic-models` Docker volume, which survives re-creates. Copy a result out with `docker cp crow-heretic:/models/<name> ./`.
- Large models: `--quantization bnb_4bit` lowers memory use. `heretic --help` lists every option.
- Gated models: set **HERETIC_HF_TOKEN** in the extension's settings and restart it.

To chat with a result in Crow, convert it to GGUF and add it through the Model Catalog. That's the owner's deliberate choice, never automatic.

## Sharing the GPU

A run occupies the GPU for a long time. Models already served on this machine slow down or fail to start meanwhile. Pick a quiet time, and stop the extension afterwards.

## Status

Draft: the container image hasn't been built and smoke-tested on real hardware yet, so the extension isn't offered in the store.

## Licence

Heretic is **AGPL-3.0-or-later** (https://github.com/p-e-w/heretic). Crow ships only a Dockerfile that installs the unmodified PyPI release (`heretic-llm`) in its own container, and links none of its code. If a Crow host offers Heretic to other people over a network, it must offer them Heretic's source. For the unmodified release, a link to upstream is enough.
