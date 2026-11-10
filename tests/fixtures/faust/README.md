# Faust test fixtures

Four `.dsp` files, all of which compile, that the licence lint refuses. They are
the negative fixtures of `bundles/studio/tools/build-faust.mjs`: real compiled
metadata (and real source) rather than a hand-written meta array.

| file | why it must be refused |
|---|---|
| `gpl-compressor.dsp` | `co.FFcompressor_N_chan` declares `GPL-3.0-only` in the meta |
| `agpl-process-array.dsp` | `ba.processArray` declares `AGPL-3.0-only` in the meta |
| `gpl-sliding.dsp` | `ba.slidingMax` is GPL-3.0-only **declared only in a comment** — the meta is silent |
| `gpl-stk-caller.dsp` | `fi.avg_rect` declares STK-4.3 but its body calls `ba.slidingMean` |

The last two are the interesting ones: they are what a lint that only reads the
compiled meta cannot see. `gpl-sliding.dsp` produces no licence entry for the
GPL function at all (so the refusal comes from the `.dsp` text), and
`gpl-stk-caller.dsp` produces a *permissive* entry for the function Crow would
call (so the refusal comes from the denylist that names it).

Both are refused by `lintProgram` in `bundles/studio/tools/build-faust.mjs`, and
`tests/studio-faust-effects.test.js` pins that: the refusal names the function
and says "GPL-3.0 (declared only in a comment)", and the build refuses to write
an effect that used one.