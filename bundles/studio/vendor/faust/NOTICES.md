# Faust effect licences

Studio's Faust effects are compiled from `bundles/studio/effects/*.dsp` with
the Faust compiler (`@grame/faustwasm`, at build time only). The Faust
standard library is licensed per function, so each compiled effect carries
the union of the licences its functions declared. The build's licence lint
allows only MIT, BSD-2-Clause, BSD-3-Clause, STK-4.3 and LGPL-2.1 with the
Faust exception; everything else refuses the build.

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
declares one. These libraries were used without a declaration, so the
compiled meta states no terms for their functions. Every licence it DOES
state is listed above and passed the lint; the silent ones are Faust's own
libraries, whose file headers carry the STK-4.3 or LGPL-with-Faust-exception
notice the declarations next to them use.

- chorus: delays.lib, platform.lib
- delay: delays.lib, platform.lib
- eq: basics.lib, platform.lib, routes.lib, signals.lib
- filter: platform.lib
- phaser: phaflangers.lib, platform.lib
- reverb: basics.lib, delays.lib, oscillators.lib, platform.lib, routes.lib, signals.lib
- saturation: platform.lib

## Notes

- **MIT** and **BSD** entries need no text of their own here: the Faust
  libraries that declare them ship their own notices in
  `node_modules/@grame/faustwasm` (the compiler package), and both licences
  ask only that the copyright notice travel with the code. The functions
  this directory uses under MIT are `re.jpverb` (Julian Parker, with fixes
  by Till Bovermann) and the phaser/allpass functions of the phaser library
  (Julius O. Smith III).
- **LicenseRef-LGPL-2.1-or-later-with-Faust-exception** is the LGPL with the
  Faust exception that lets generated code ship under Crow's own terms.
- **STK-4.3** is the permissive, MIT-style licence of the Synthesis ToolKit,
  which the filter and effect libraries' `jos` sections carry. Its text is
  below.

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
