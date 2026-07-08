# H.2 35b leg + H.3 MTP sweep — overnight kit (2026-07-07)

> **REBUILT 2026-07-08 (post-incident) — re-arm is Kevin's call.** The
> 02:30 run was VOID and its restore failure left prod down 02:30–03:47
> (see `results-20260708-0230/INCIDENT.md`). All five incident fixes are
> in: `.env`-safe compose (preflight fails on unresolved vars), every
> image → `vulkan-radv-mtp` (rocm-7.2.1 can run NO phase of this bench;
> prod always ran vulkan-radv-mtp), deadman as its OWN systemd unit
> (setsid/nohup dies with the runner's cgroup — how the backstop was lost),
> compose-up restore with retry from each addon's own dir (containers get
> REMOVED; `docker start` can't recreate), in-window self-test + abort-early.
> **Validated live 2026-07-08 ~04:00**: preflight env assertion, ppl
> gguf-load on the vulkan image (2-chunk co-resident, prod untouched),
> serve-on-vulkan + addon-dir restore (they ARE tonight's manual recovery).
> **Not yet validated**: q8-mtp2 serve compatibility (needs a prod stop —
> that's the first thing the window itself now self-tests, with abort-early).
> Re-arm: `systemd-run --user --on-calendar="02:30" --unit=h2-35b-overnight bash /home/kh0pp/crow/scripts/bench/h2-35b-overnight/run.sh`

One bots-down window, scheduled for **02:30** via transient systemd user timer
`h2-35b-overnight`. Measures everything, ships NOTHING unattended — prod is
always restored to the snapshotted f16/MTP2 compose at the end (or by the
detached 4-h deadman if the runner dies). ntfy pushes on start, finish, and
deadman fire (topic `pi`).

## What it runs
1. **Quality (H.2)** — llama-perplexity on the serving image (rocm-7.2.1),
   Qwen3.6-35B-A3B-UD-Q5_K_XL as its OWN base: KLD f16-KV base (ctx512×48)
   → KLD q8_0-KV vs base → PPL@4096×40 both sides. Same protocol as the
   copilot leg (results comparable).
2. **Serve perf (H.2)** — f16/MTP2 vs q8/MTP2: prefill (32.6k tok, raw
   /completion, cache off), gen (128 tok), critique (real-diff 16.5k-tok
   prompt via chat endpoint, 512 tok). KV buffer sizes from server logs.
3. **MTP sweep (H.3)** — critique-gen at MTP off / 2 / 3 / 4 (f16 KV),
   acceptance rate from `timings.draft_n / draft_n_accepted`.

## Live baseline (prod f16/MTP2, smoked 2026-07-07 10:05)
prefill@16.5k ≈ 700 tok/s · gen 74 tok/s (acc 0.90 on words) ·
critique-gen 65.2 tok/s (acc 0.806, 391 drafts). MTP confirmed WORKING on
rocm-7.2.1 (the old "needs vulkan-radv-mtp image" note is stale).

## Morning review
Results in `results-<stamp>/RESULTS.md` (+ full run.log).
- **Ship q8 KV** if mean KLD ≲ 0.01 (copilot was 0.0016, but this is a
  DIFFERENT gguf — Q5_K_XL MoE), ΔPPL@4096 within noise, and prefill/gen
  deltas acceptable. KV prize at 262144: f16 = 16 GB class → q8 ≈ −47%.
- **MTP depth**: keep the depth with the best critique-gen median; expect
  acceptance to drop with depth — depth pays only while acc stays high.
- If q8-mtp2 never became healthy, q8 KV + MTP draft context may be
  incompatible on this build — the run.log has the container tail.
- Ship = copy the winning compose variant over
  `~/crow-addons/llamacpp-vulkan-qwen36-35b-a3b/docker-compose.yml` and
  `docker compose up -d` (2-min attended restart; update the compose comment).

## Controls
- Cancel tonight's run: `systemctl --user stop h2-35b-overnight.timer`
- Run it NOW instead:   `systemctl --user start h2-35b-overnight.service`
  (or `bash run.sh` in a detached shell)
- Deadman log: `deadman.log` · prod snapshot: `compose-prod-snapshot.yml`
