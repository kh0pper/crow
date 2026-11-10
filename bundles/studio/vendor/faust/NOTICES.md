# Faust effect licences

Studio's Faust effects are compiled from `bundles/studio/effects/*.dsp` with
the Faust compiler (`@grame/faustwasm`, at build time only, LGPL-2.1 — its
notice is `LICENSE-faustwasm.txt` beside this file). The Faust standard
library is licensed per function, so each compiled effect carries the union
of the licences its functions declared.

## How the lint decides what ships

`bundles/studio/tools/build-faust.mjs` refuses an effect unless all three of
these pass:

1. **The licence declarations in the compiled meta.** Only MIT,
   BSD-2-Clause, BSD-3-Clause, STK-4.3 and LGPL-2.1 with the Faust exception
   may ship; anything else (the GPL-only and AGPL-only functions included)
   refuses the build.
2. **An allowlist of reviewed libraries that declare nothing.** Faust's own
   libraries do not all carry a `declare license`, and a library that
   declares nothing contributes nothing to the meta — so the build refuses
   any such library unless the allowlist names it *at the version the meta
   reports*, with the terms its file header states in a comment. A
   `faustwasm` upgrade that bumps one of these libraries refuses the build
   until someone reads the new header.
3. **A denylist of GPL-3.0-only code that is declared only in a comment.**
   `basics.lib`'s `sliding*` block carries
   `// SPDX-License-Identifier: GPL-3.0` and no `declare license` at all, so
   a program that calls it compiles with no GPL entry anywhere; and
   permissively declared functions call it in turn (`filters.lib/avg_rect`
   is `ba.slidingMean`). Those names are refused by match on the compiled
   meta and on the `.dsp` sources.

**The denylist is maintained by review, not derived from the meta.** The
meta records every declared function a program reaches, transitively, but
nothing about undeclared code: `ba.slidingMean` is GPL only in a comment, so
a program reaching it leaves no GPL entry. A declared caller such as
`fi.avg_rect` does leave its own entry, which is why the denylist names
the declared callers too. Reading each new effect's sources, and re-reading
the libraries on a `faustwasm` upgrade, is what keeps the list complete.

## What each effect uses

### chorus

- LicenseRef-LGPL-2.1-or-later-with-Faust-exception: `maths.lib`
- LicenseRef-STK-4.3: `oscillators.lib/lf_sawpos`

### delay

- LicenseRef-LGPL-2.1-or-later-with-Faust-exception: `maths.lib`
- LicenseRef-STK-4.3: `filters.lib/lowpass`, `filters.lib/lowpass0_highpass1`, `filters.lib/tf1s`
- MIT: `filters.lib/_tanhalf`

### eq

- LicenseRef-LGPL-2.1-or-later-with-Faust-exception: `maths.lib`
- LicenseRef-STK-4.3: `filters.lib/fir`, `filters.lib/high_shelf`, `filters.lib/highpass`, `filters.lib/highshelf`, `filters.lib/iir`, `filters.lib/low_shelf`, `filters.lib/lowpass`, `filters.lib/lowpass0_highpass1`, `filters.lib/lowshelf`, `filters.lib/peak_eq`, `filters.lib/svf`, `filters.lib/tf1`, `filters.lib/tf1s`, `filters.lib/tf1s_df`, `filters.lib/tf2`, `filters.lib/tf2s`, `filters.lib/tf2s_df`
- MIT: `analyzers.lib/analyzer_tpt_df`, `filters.lib/_tanhalf`, `filters.lib/_tpt_df`, `filters.lib/filterbank_tpt_df`, `filters.lib/highpass_tpt_df`, `filters.lib/lowpass_tpt_df`

### filter

- LicenseRef-LGPL-2.1-or-later-with-Faust-exception: `maths.lib`
- LicenseRef-STK-4.3: `filters.lib/resonbp`, `filters.lib/resonhp`, `filters.lib/resonlp`, `filters.lib/tf2s`
- MIT: `filters.lib/_tanhalf`

### phaser

- LicenseRef-LGPL-2.1-or-later-with-Faust-exception: `maths.lib`
- LicenseRef-STK-4.3: `oscillators.lib/lf_sawpos`

### reverb

- LicenseRef-LGPL-2.1-or-later-with-Faust-exception: `maths.lib`
- LicenseRef-STK-4.3: `filters.lib/fir`, `filters.lib/highpass`, `filters.lib/highpass_plus_lowpass`, `filters.lib/iir`, `filters.lib/lowpass`, `filters.lib/lowpass0_highpass1`, `filters.lib/nlf2`, `filters.lib/svf`, `filters.lib/tf1`, `filters.lib/tf1s`, `filters.lib/tf1s_df`, `filters.lib/tf2`, `filters.lib/tf2s`, `filters.lib/tf2s_df`
- MIT: `analyzers.lib/analyzer_tpt_df`, `filters.lib/_tanhalf`, `filters.lib/_tpt_df`, `filters.lib/filterbank_tpt_df`, `filters.lib/highpass_plus_lowpass_tpt_df`, `filters.lib/highpass_tpt_df`, `filters.lib/lowpass_tpt_df`, `reverbs.lib/jpverb`

### saturation

- LicenseRef-LGPL-2.1-or-later-with-Faust-exception: `maths.lib`
- LicenseRef-STK-4.3: `filters.lib/lowpass`, `filters.lib/lowpass0_highpass1`, `filters.lib/tf1s`
- MIT: `filters.lib/_tanhalf`

## Libraries that declare no licence

The compiler emits a licence entry only for a function or library that
declares one, so these libraries were used without the compiled meta
stating any terms for them. None of them is accepted on trust: each is on
the build's reviewed allowlist, at the version below, because its file
header (a comment, which the compiler never copies into a meta) states
terms Crow may ship under. They are Faust's own libraries; the citations
are the Faust libraries as `faustwasm` ships them, in its
`libfaust-wasm.data`.

- `basics.lib` 1.23.6 — LGPL-2.1-or-later with the Faust exception (GRAME header comment, libfaust-wasm.data ~4238-4268), except its JOS section (~4421-4722, incl. ba.bypass1/bypass2/bypass1to2 marked STK-4.3 in comments), which is STK-4.3.
  Used by: eq, reverb.
  Copyright (C) 2003-2017 by Julius O. Smith III (the JOS section, STK-4.3).
- `delays.lib` 1.3.3 — LGPL-2.1-or-later with the Faust exception (header comment, libfaust-wasm.data ~11392-11421).
  Used by: chorus, delay, reverb.
- `oscillators.lib` 1.9.5 — LGPL-2.1-or-later with the Faust exception (GRAME header comment, libfaust-wasm.data ~42320-42360), except its JOS section (~42993 on), which is STK-4.3; the functions Crow uses from it declare their own STK-4.3.
  Used by: reverb.
  Copyright (C) 2003-2022 by Julius O. Smith III (the JOS section, STK-4.3).
- `phaflangers.lib` 1.1.3 — STK-4.3 (the MIT-style Synthesis ToolKit licence) for the functions Crow uses: its JOS section header, libfaust-wasm.data ~45554-45562, places the functions below it (phaser2_stereo included, ~45826) under STK-4.3; its GRAME/LGPL block (~45831-45865) is empty.
  Used by: phaser.
  Copyright (C) 2003-2017 by Julius O. Smith III (the JOS section, STK-4.3).
- `platform.lib` 1.3.1 — LGPL-2.1-or-later with the Faust exception (header comment, libfaust-wasm.data ~52482-52515).
  Used by: chorus, delay, eq, filter, phaser, reverb, saturation.
- `routes.lib` 1.4.1 — LGPL-2.1-or-later with the Faust exception (header comment, libfaust-wasm.data ~55017-55050).
  Used by: eq, reverb.
- `signals.lib` 1.8.0 — LGPL-2.1-or-later with the Faust exception (GRAME header comment, libfaust-wasm.data ~55723-55757), except its JOS section (~56024 on, si.smooth onward), which is STK-4.3.
  Used by: eq, reverb.
  Copyright (C) 2003-2017 by Julius O. Smith III (the JOS section, STK-4.3).

## Copyright and authorship

The compiler's meta records the author and copyright line a library
declares, per function where it declares one and per library otherwise.
They are reproduced here, grouped by library, because MIT, BSD and STK-4.3
all require the notice to travel with the code. A function with no entry
of its own is covered by its library's entry, or (for a library in the
list above) by the header cited there.

### analyzers.lib

- `analyzer_tpt_df` — author: Julius O. Smith III

### delays.lib

- `fdelay1a` — author: Julius O. Smith III
- `fdelay4` — author: Julius O. Smith III
- `fdelayltv` — author: Julius O. Smith III

### filters.lib

- `_tanhalf` — author: Julius O. Smith III
- `_tpt_df` — author: Julius O. Smith III
- `filterbank_tpt_df` — author: Julius O. Smith III
- `fir` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `high_shelf` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `highpass` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `highpass_plus_lowpass` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `highpass_plus_lowpass_tpt_df` — author: Julius O. Smith III
- `highpass_tpt_df` — author: Julius O. Smith III
- `highshelf` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `iir` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `low_shelf` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `lowpass` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `lowpass0_highpass1` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `lowpass_tpt_df` — author: Julius O. Smith III
- `lowshelf` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `nlf2` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `peak_eq` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `resonbp` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `resonhp` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `resonlp` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `svf` — author: Oleg Nesterov; copyright: Copyright (C) 2020 Oleg Nesterov <oleg@redhat.com>
- `tf1` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `tf1s` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `tf1s_df` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `tf2` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `tf2s` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>
- `tf2s_df` — author: Julius O. Smith III; copyright: Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>

### maths.lib

- the library itself — author: GRAME; copyright: GRAME

### oscillators.lib

- `lf_sawpos` — author: Bart Brouns, revised by Stéphane Letz

### reverbs.lib

- `jpverb` — author: Julian Parker, bug fixes and minor interface changes by Till Bovermann

## Notes

- **MIT.** Its text is below, once. The MIT functions this build ships are
  `analyzers.lib/analyzer_tpt_df`, `filters.lib/_tanhalf`, `filters.lib/_tpt_df`, `filters.lib/filterbank_tpt_df`, `filters.lib/highpass_plus_lowpass_tpt_df`, `filters.lib/highpass_tpt_df`, `filters.lib/lowpass_tpt_df`, `reverbs.lib/jpverb`. Their copyright lines are under "Copyright and authorship".
- **BSD-2-Clause and BSD-3-Clause** likewise ask only that the copyright
  notice travel with the code; it is under 'Copyright and authorship'.
- **LicenseRef-LGPL-2.1-or-later-with-Faust-exception** is the LGPL with the
  Faust exception, which lets generated code ship under Crow's own terms.
  The compiler package's own LGPL notice — a different thing, and not the
  licence of the compiled effects — is `LICENSE-faustwasm.txt`.
- **STK-4.3** is the permissive, MIT-style licence of the Synthesis ToolKit
  (no relation to the MIT-declared functions above), which the filter and
  effect libraries' `jos` sections carry. Its text is below.
- **`pf.phaser2_stereo`** (the phaser effect) carries no licence
  declaration, so it appears in no row above: `phaflangers.lib` is one of
  the reviewed libraries in the list above, and its JOS section header
  places the functions below it under STK-4.3 — which is what the phaser
  ships under, NOT the MIT of the reverb's `jpverb` or of the `_tpt_df`
  filters.

## MIT

```text
Copyright (c) the authors of the functions listed above

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## STK 4.3

Taken verbatim from the Faust libraries the compiler ships, in
`libfaust-wasm.data`: the licence appendix of `wdmodels.lib` (the text the
Faust documentation links to as `stk-4.3-license`). Trailing whitespace is
the only edit.

```text
Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

Any person wishing to distribute modifications to the Software is asked to send
the modifications to the original developer so that they can be incorporated
into the canonical version.  For software copyrighted by Julius O. Smith III,
email your modifications to <jos@ccrma.stanford.edu>.  This is, however, not a
binding provision of this license.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
