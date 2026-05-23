# §1.A — 35B MTP + vision compatibility gate: PASS (2026-05-22)

Build: llama.cpp 9189 (64b38b561), image kyuz0/amd-strix-halo-toolboxes:rocm-7.2.3
Model: Qwen3.6-35B-A3B-UD-Q6_K (MTP) + mmproj-F16, flags: --spec-type draft-mtp --spec-draft-n-max 2 -np 1 -c 16384

(a) Server started WITH both --mmproj and --spec-type draft-mtp — NO "speculative decoding is not
    supported with multimodal" error. READY in 42s.
(b) Vision works: read the test image exactly — "CROW VISION" (black) + "TEST 7429" (red), correct
    colors/layout.
(c) MTP active: accept=78.3% (775/990), draft-mtp statistics present; 55.15 gen tok/s, 100.7 pp tok/s
    @ ctx16k single-stream (Q6, code/greedy) — vs ~44.6 non-MTP solo prod baseline.

CONCLUSION: MTP + vision co-load on build 9189. The earlier "MTP means no vision" no longer holds.
35B test target = MTP + vision (confirmed). Note: MTP still forces -np 1 (no --parallel >1).
