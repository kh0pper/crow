# PIR head-to-head: 35B vs 27B under the current hardened design

Controlled A/B: the **same PIR**, **N=5 each**, identical gates (computed_facts +
claims gate + commit-gate), the only variable being the served model. Run via
`pir-fullflow.mjs --model 35b|27b`. 2026-06-05.

- 27B: Qwen non-thinking preset, temp 0.7 (the PIR config).
- 35B: the shared daily driver, served as-deployed.

## Results

### 2503540 — reply with a PDF entity count (27 / 8)

| | 35B | 27B |
|---|---|---|
| Verdict | PASS ×5 | PASS ×5 |
| Count correct (27/8), never wrong | ✅ (stated 3/5, declined 2/5) | ✅ (stated 5/5) |
| Fabricated a wrong count | 0/5 | 0/5 |
| Median wall / rep | **124 s** | 693 s (**5.6× slower**) |

**Dead even on accuracy.** Both always get the count right (or safely omit) —
because `computed_facts` hands both models the verified 27/8 and the claims gate
catches anything off. The model no longer carries the accuracy; the guardrails do.

### AISD-R873 — reasoning-heavy PIA dispute (FERPA / #9b / #4c / closure)

| | 35B | 27B |
|---|---|---|
| Verdict | PASS ×5 | PASS ×5 |
| Substantive reasoning correct | ✅ ×5 | ✅ ×5 |
| em dashes (voice violation) | **3/5** | 0/5 |
| markdown headers (off-spec) | 1/5 | 0/5 |
| **fabricated PII (phone #)** | **1/5** | **0/5** |
| Median wall / rep | **~134 s** | ~721 s (**~5.4× slower**) |

**Argument-equivalent, reliability-divergent.** Both models make the *correct*
core arguments every run: FERPA protects individually-identifiable records, not
aggregated campus-level transfer counts (which TEA already publishes via PEIMS);
a cost estimate is not a statutory citation for #4c; §552.2615 bars unilateral
closure of contested items. The 27B was even sharper on precedent in places
(citing AISD's own prior #9a out-of-district production).

The difference is **cleanliness and fabrication**, not reasoning:
- **27B: 5/5 perfectly clean** — no em dashes, no markdown, no invented contact info.
- **35B: voice slips in 4/5 and fabricated a phone number in 1/5** — exactly the
  unreliability that justified putting replies on the 27B in Phase-0. The em-dash
  slips are auto-stripped by the dispatcher's `normalizeVoice`, but the fabricated
  phone number and markdown headers are **not** caught by any current guard.

## Conclusion

- On **accuracy**, the two models are equivalent under the current gates — the
  Phase-0 gap (35B fabricated counts, both 0/5 on the PDF count) was closed by
  `computed_facts` + the claims gate, not by the model choice.
- On **reliability of outbound prose**, the **27B is clearly safer**: zero
  fabrication, perfect voice adherence, at the cost of ~5–6× the wall time.
- The 35B is argument-equivalent and ~5–6× faster, but **occasionally fabricates
  PII and frequently slips voice** — unacceptable as-is for outbound legal mail.

## Recommendation

- **Keep replies on the 27B** for high-stakes correspondence — its no-fabrication,
  clean-voice reliability earns the speed cost on legal mail.
- **OR move replies to the 35B only with added guards**: a fabrication/PII guard
  (validate the signature block; strip invented phone numbers / any contact info
  not in the voice profile) + a markdown stripper, on top of the existing em-dash
  normalizer. With those, the 35B's ~5× speedup would make the 58-corpus reply
  pass far cheaper. Worth building if reply throughput becomes the bottleneck.
- Deliveries stay on the 35B (fast; counts are tool-derived; the commit-gate
  catches lapses).

## Caveat

Two reply PIRs (2503540 easy/count, AISD-R873 hard/reasoning). A broader sweep
(more reply types, cost-estimate and no-responsive cases) would harden the
recommendation, but the pattern — equal accuracy, 27B cleaner, 35B faster — is
consistent across both.
