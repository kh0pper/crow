# Qwen3.6-35B-A3B — Quant Ladder Benchmark (2026-05-24)

Everyday model quant sweep on crow (Strix Halo, 124 GB unified). Quality = **KLD vs BF16** (true reference;
the 35B's BF16 is only 67.8 GB so this is feasible, unlike the 122B). Corpus = Gutenberg prose
(`results/quality/wiki.test.raw`, CHUNKS=48 CTX=512). Speed = `mtp-explore.sh measure` on **Vulkan** (prod
backend), MTP draft-n2 + vision, ctx 16K, greedy, 5-run median. BF16 PPL reference = **1.5960**.

| Quant | On-disk | PPL | PPL vs BF16 | Mean KLD | Median KLD | Same-top-tok | RMS Δp | code tok/s | prose tok/s | draft accept |
|-------|---------|-----|-------------|----------|------------|--------------|--------|-----------|-------------|--------------|
| BF16 (ref) | 67.8 GB | 1.5960 | — | 0 | 0 | 100% | 0 | — | — | — |
| Q8_K_XL | 37.3 GB | 1.6007 | +0.29% | 0.0104 | 0.000089 | 98.27% | 4.39% | 56.5 | 53.9 | 80% |
| **Q6_K (current)** | 28.6 GB | 1.5966 | +0.03% | 0.0117 | 0.000112 | 98.11% | 4.40% | 66.2 | 62.1 | 83% |
| Q5_K_XL | 25.9 GB | 1.6050 | +0.56% | 0.0153 | 0.000145 | 97.84% | 5.26% | 69.6 | 62.9 | 83% |
| Q4_K_XL | 21.8 GB | 1.6081 | +0.76% | 0.0281 | 0.000313 | 97.27% | 7.10% | 71.5 | 65.5 | 81% |
| Q3_K_XL | 16.4 GB | 1.7652 | +10.6% | 0.1095 | 0.002218 | 94.18% | 14.32% | 76.0 | 73.6 | 80% |

## Findings
- **Quality ceiling is reached by Q6.** Q8 (KLD 0.0104) is only a rounding-error more faithful than Q6
  (0.0117) — both ~2-3× under the "near-lossless" bar — but Q8 is **15% slower** and 9 GB bigger. Q8 not worth it.
  (Note PPL is non-monotonic — Q6 PPL is coincidentally closest to BF16; KLD is the reliable fidelity metric,
  and by KLD the order is Q8 ≳ Q6 > Q5 > Q4 ≫ Q3.)
- **Q3 crosses a real cliff** — KLD 0.11 (~10× Q4), +10.6% PPL, top-token 94%. The 35B is MORE quant-sensitive
  than the 122B (whose Q3 was only +3% PPL / KLD 0.031) — smaller model, less redundancy. Don't ship 35B-Q3.
- **Q5_K_XL = sweet spot:** statistically tied with Q6 on quality (KLD 0.015 vs 0.012, top-token 97.8% vs 98.1%)
  but ~5% faster + 3 GB smaller.
- **Q4_K_XL = speed pick:** 71/76 tok/s (~8-15% over Q6) at a small real cost (KLD 0.028, top-token 97.3% —
  about as faithful as the 122B-Q3 we examined). Fine for an everyday model if you want it snappier.
- Speed scales inversely with size (bandwidth-bound APU). Q6→Q5 +5% / Q6→Q4 +8% code; Q6→Q8 −15%.

## Recommendation
Q6 (current) is safe/near-lossless. **Q5_K_XL is a free-ish upgrade** (same quality, a bit faster/smaller).
**Q4_K_XL** if you prioritize interactive speed and accept a small quality cost. Avoid Q8 (slower, no gain)
and Q3 (quality cliff). Raw logs: `results/q35*` / `results/quality/`.
