[05:23:17] === SWEEP-B START (resume; -fit off; per-step timeouts) ===
[mem] free=102 avail=120 GB
[05:23:20] ## 122B quality (PPL-delta; eval=Gutenberg prose)
    2.49.567.066 I Final estimate: PPL = 1.7743 +/- 0.02446
    --- PPL summary (122b-q5) ---
    2.49.567.066 I Final estimate: PPL = 1.7743 +/- 0.02446
    saved: /home/kh0pp/crow/scripts/bench/results/quality/ppl-122b-q5-20260523T052320Z.log
[05:26:11] staging 122B Q4_K_XL -> NVMe
[05:38:47] staged Q4 (74G)
    2.11.982.657 I Final estimate: PPL = 1.7802 +/- 0.02458
    --- PPL summary (122b-q4) ---
    2.11.982.657 I Final estimate: PPL = 1.7802 +/- 0.02458
    saved: /home/kh0pp/crow/scripts/bench/results/quality/ppl-122b-q4-20260523T053847Z.log
[05:41:00] ## 35B speed (Qwen3.6-35B-A3B MTP+vision)
[05:41:00] >>> 35B Q6 ROCm  MTP-n2 +vis
launched mtp-test-8013 (q36-q6-mtp2) backend=rocm ctx=16384 fa=on np=1 mmproj=/models/qwen36-35b-a3b-mtp/mmproj-F16.gguf img=kyuz0/amd-strix-halo-toolboxes:rocm-7.2.3 flags: --spec-type draft-mtp --spec-draft-n-max 2
READY after 15s
    code  runs=5 gen_tok/s median=59.16 min=59.07 max=61.45  pp_tok/s median=113.8  accept=78.3%(775/990)
    draft acceptance rate = 0.78283 (  155 accepted /   198 generated)
    prose runs=5 gen_tok/s median=58.94 min=58.79 max=59.18  pp_tok/s median=112.4  accept=78.3%(775/990)
[05:42:01] >>> 35B Q6 ROCm  MTP-n2 KV-q8
launched mtp-test-8013 (q36-q6-mtp2kv8) backend=rocm ctx=16384 fa=on np=1 mmproj=/models/qwen36-35b-a3b-mtp/mmproj-F16.gguf img=kyuz0/amd-strix-halo-toolboxes:rocm-7.2.3 flags: --spec-type draft-mtp --spec-draft-n-max 2 --cache-type-k q8_0 --cache-type-v q8_0
READY after 5s
    code  runs=5 gen_tok/s median=58.54 min=58.45 max=60.33  pp_tok/s median=111.8  accept=79.6%(780/980)
    draft acceptance rate = 0.79592 (  156 accepted /   196 generated)
[05:42:30] >>> 35B Q6 Vulkan MTP-n2 +vis
launched mtp-test-8013 (q36-q6-vk-mtp2) backend=vulkan ctx=16384 fa=on np=1 mmproj=/models/qwen36-35b-a3b-mtp/mmproj-F16.gguf img=kyuz0/amd-strix-halo-toolboxes:vulkan-radv-mtp flags: --spec-type draft-mtp --spec-draft-n-max 2
READY after 10s
    code  runs=5 gen_tok/s median=66.55 min=66.20 max=69.19  pp_tok/s median=105.2  accept=82.6%(790/956)
    draft acceptance rate = 0.82723 (  158 accepted /   191 generated)
[05:43:01] >>> 35B Q6 ROCm  non-MTP parallel4 (prod ref)
launched mtp-test-8013 (q36-q6-p4) backend=rocm ctx=16384 fa=on np=4 mmproj=/models/qwen36-35b-a3b-mtp/mmproj-F16.gguf img=kyuz0/amd-strix-halo-toolboxes:rocm-7.2.3 flags: 
READY after 6s
    code  runs=5 gen_tok/s median=47.25 min=47.24 max=47.36  pp_tok/s median=117.6
[05:43:35] staging 35B Q5_K_M -> NVMe
[05:48:24] staged Q5
[05:48:24] >>> 35B Q5 ROCm  MTP-n2 +vis
launched mtp-test-8013 (q36-q5-mtp2) backend=rocm ctx=16384 fa=on np=1 mmproj=/models/qwen36-35b-a3b-mtp/mmproj-F16.gguf img=kyuz0/amd-strix-halo-toolboxes:rocm-7.2.3 flags: --spec-type draft-mtp --spec-draft-n-max 2
READY after 6s
    code  runs=5 gen_tok/s median=63.23 min=63.01 max=64.52  pp_tok/s median=115.8  accept=81.4%(790/970)
    draft acceptance rate = 0.81443 (  158 accepted /   194 generated)
    prose runs=5 gen_tok/s median=59.15 min=57.88 max=59.63  pp_tok/s median=114.5  accept=76.2%(770/1010)
[05:49:13] >>> 35B Q5 Vulkan MTP-n2 +vis
launched mtp-test-8013 (q36-q5-vk-mtp2) backend=vulkan ctx=16384 fa=on np=1 mmproj=/models/qwen36-35b-a3b-mtp/mmproj-F16.gguf img=kyuz0/amd-strix-halo-toolboxes:vulkan-radv-mtp flags: --spec-type draft-mtp --spec-draft-n-max 2
READY after 10s
    code  runs=5 gen_tok/s median=68.88 min=67.12 max=72.35  pp_tok/s median=109.3  accept=82.7%(792/958)
    draft acceptance rate = 0.80928 (  157 accepted /   194 generated)
[05:49:44] ## 35B quality (KLD vs BF16 + PPL)
[05:49:44] staging 35B BF16 -> NVMe
[06:00:21] staged BF16 (67G)
    
    base written to /work/35b-bf16.dat (host: /home/kh0pp/crow/scripts/bench/results/quality/35b-bf16.dat)
    chunk             PPL               ln(PPL(Q)/PPL(base))          KL Divergence              Δp RMS            Same top p
    Mean PPL(Q)                   :   1.596598 ±   0.018764
    Mean PPL(base)                :   1.596679 ±   0.018823
    Cor(ln(PPL(Q)), ln(PPL(base))):  99.14%
    Mean ln(PPL(Q)/PPL(base))     :  -0.000050 ±   0.001548
    Mean PPL(Q)/PPL(base)         :   0.999950 ±   0.001548
    Mean PPL(Q)-PPL(base)         :  -0.000080 ±   0.002471
    Mean    KLD:   0.011726 ±   0.000723
    Maximum KLD:   2.888118
    Median  KLD:   0.000112
    Mean    Δp: -0.036 ± 0.040 %
    Maximum Δp: 80.882%
    Median  Δp:  0.000%
    RMS Δp    :  4.403 ± 0.187 %
    Same top p: 98.105 ± 0.123 %
    chunk             PPL               ln(PPL(Q)/PPL(base))          KL Divergence              Δp RMS            Same top p
    Mean PPL(Q)                   :   1.596598 ±   0.018764
    Mean PPL(base)                :   1.596679 ±   0.018823
    Mean ln(PPL(Q)/PPL(base))     :  -0.000050 ±   0.001548
    Mean PPL(Q)/PPL(base)         :   0.999950 ±   0.001548
    Mean PPL(Q)-PPL(base)         :  -0.000080 ±   0.002471
    Mean    KLD:   0.011726 ±   0.000723
    Maximum KLD:   2.888118
    Median  KLD:   0.000112
    Mean    Δp: -0.036 ± 0.040 %
    Maximum Δp: 80.882%
    Median  Δp:  0.000%
    RMS Δp    :  4.403 ± 0.187 %
    Same top p: 98.105 ± 0.123 %
    saved: /home/kh0pp/crow/scripts/bench/results/quality/kld-35b-q6-20260523T060155Z.log
    chunk             PPL               ln(PPL(Q)/PPL(base))          KL Divergence              Δp RMS            Same top p
    Mean PPL(Q)                   :   1.604830 ±   0.018973
    Mean PPL(base)                :   1.596679 ±   0.018823
    Cor(ln(PPL(Q)), ln(PPL(base))):  98.83%
    Mean ln(PPL(Q)/PPL(base))     :   0.005092 ±   0.001806
    Mean PPL(Q)/PPL(base)         :   1.005105 ±   0.001815
    Mean PPL(Q)-PPL(base)         :   0.008151 ±   0.002895
    Mean    KLD:   0.015340 ±   0.000972
    Maximum KLD:   5.349475
    Median  KLD:   0.000145
    Mean    Δp: -0.226 ± 0.048 %
    Maximum Δp: 83.031%
    Median  Δp: -0.000%
    RMS Δp    :  5.261 ± 0.220 %
    Same top p: 97.835 ± 0.132 %
    chunk             PPL               ln(PPL(Q)/PPL(base))          KL Divergence              Δp RMS            Same top p
    Mean PPL(Q)                   :   1.604830 ±   0.018973
    Mean PPL(base)                :   1.596679 ±   0.018823
    Mean ln(PPL(Q)/PPL(base))     :   0.005092 ±   0.001806
    Mean PPL(Q)/PPL(base)         :   1.005105 ±   0.001815
    Mean PPL(Q)-PPL(base)         :   0.008151 ±   0.002895
    Mean    KLD:   0.015340 ±   0.000972
    Maximum KLD:   5.349475
    Median  KLD:   0.000145
    Mean    Δp: -0.226 ± 0.048 %
    Maximum Δp: 83.031%
    Median  Δp: -0.000%
    RMS Δp    :  5.261 ± 0.220 %
    Same top p: 97.835 ± 0.132 %
    saved: /home/kh0pp/crow/scripts/bench/results/quality/kld-35b-q5-20260523T060244Z.log
[06:03:30] === SWEEP-B DONE — summary: /home/kh0pp/crow/scripts/bench/results/SWEEP-B-SUMMARY-20260523T052317Z.md ===
[06:03:30] RESTORE: cleanup strays + docker start GPU containers
[06:03:56] crow-chat :8003 healthy
