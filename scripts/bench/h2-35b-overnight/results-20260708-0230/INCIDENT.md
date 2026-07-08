# h2-35b-overnight 2026-07-08: run void + failed restore (prod down 02:30–03:47)

## Outcome

**Zero usable data.** Every phase failed, and the end-of-window restore also
failed, leaving the 35b (bots) and copilot down until manual restoration at
03:47 CDT (~27 min beyond the intended window; bots dark ~77 min total).
H.2 (35b q8 KV) and H.3 (MTP depth sweep) remain OPEN — no measurements.

## Failure chain (three independent bugs, one root misconception)

1. **Missing env at compose time.** The 35b addon dir had no `.env`;
   `LLM_CACHE`/`VIDEO_GID`/`RENDER_GID`/`CROW_TAILSCALE_IP` are normally
   supplied by the crow addon manager. run.sh ran `docker compose up -d`
   bare in that dir, so `${LLM_CACHE}:/models` expanded to `:/models` →
   `invalid spec: :/models: empty section between colons` → **every serve
   variant failed to create a container**, including the restore.
2. **Restore fallback was dead.** `down()` between variants had already
   *removed* the stopped prod container, so the restore's
   `docker start "$C35"` fallback hit "No such container". The copilot's
   `docker start "$COP"` also failed silently (stderr discarded). The
   deadman only guarded runner death — the runner exited "successfully",
   so nothing verified prod health at the end. **Prod stayed down.**
3. **Wrong serving image assumption (root misconception).** The compose
   file's `image: kyuz0/amd-strix-halo-toolboxes:rocm-7.2.1` was stale.
   That build **predates draft-mtp** (`--spec-type draft-mtp` → "unknown
   speculative decoding type"; usage lists only ngram types) and **cannot
   load this gguf** (`missing tensor 'blk.40.ssm_conv1d.weight'` — its
   qwen35moe arch predates the Qwen3.6 MTP conversion). This is why the
   quality phase (llama-perplexity on `$IMG` = rocm-7.2.1) failed in
   seconds, all four logs identical-sized error dumps. The long-running
   prod container was actually built from **vulkan-radv-mtp** — the
   2026-07-07 "MTP works on rocm-7.2.1, old note stale" verification was
   made against the wrong binary (`ghcr.io/ggml-org/llama.cpp:server` was
   pulled that same day; the original "needs vulkan-radv-mtp" note was
   correct all along). **RETRACTION**: "MTP confirmed WORKING on
   rocm-7.2.1" is false for the kyuz0 rocm-7.2.1 image on disk (cb78376e).

## Evidence

- `run.log` — full chain: missing-tensor loads (02:30), `invalid spec`
  on every variant, "No such container" from 03:00, restore ERROR lines
  03:27/03:35.
- KLD/PPL logs: 4 × 10,799-byte identical-shaped failure dumps, all
  stamped 02:30 (a real KLD pass takes ~tens of minutes each).
- Restore proof: 35b boots cleanly on vulkan-radv-mtp with the exact
  synced args — draft context initializes, generation smoke passes,
  **draft acceptance 0.897** (historical baseline ≈ 0.90).

## Remediation applied (2026-07-08 ~03:50, Claude)

- 35b restored on `vulkan-radv-mtp` from the addon dir; copilot restored;
  both `/health` OK; generation smoke OK. 4b vLLM (:8011) + embed were
  never touched.
- `~/crow-addons/llamacpp-vulkan-qwen36-35b-a3b/docker-compose.yml`:
  image corrected to `vulkan-radv-mtp` with an incident comment.
- `~/crow-addons/llamacpp-vulkan-qwen36-35b-a3b/.env` added (copy of the
  copilot's — same host facts), so bare `docker compose up -d` in that
  dir now works: removes the entire class of failure 1.
- Transient timer was one-shot; confirmed gone — no re-fire tonight.

## Before any re-run, the kit needs

1. All compose invocations env-safe (now inherently fixed by the addon
   `.env`, but run.sh should also `set -a; . $D35/.env` or pass
   `--env-file` explicitly and **fail preflight if any var is empty**).
2. Variant composes + `$IMG` rebased on an MTP-capable build that loads
   this gguf (vulkan-radv-mtp, or ghcr.io/ggml-org/llama.cpp:server after
   a compat check). rocm-7.2.1 cannot run any phase of this bench.
3. Restore path: recreate via compose (container may not exist), then
   **verify /health with a deadline and alert loudly on failure**; the
   deadman must also health-verify prod at its wall, not just kill the
   runner.
4. Preflight should smoke-boot ONE variant end-to-end (health + 1-token
   gen) before stopping prod — a 3-minute check that would have voided
   the entire incident.
