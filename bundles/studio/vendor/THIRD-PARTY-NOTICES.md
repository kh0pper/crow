# Third-party code shipped inside Studio

The Extensions page shows this list, and every file below is checked in with
its licence text beside it. Studio's own code is in the bundle's `server/`,
`panel/` and `engine/` directories; nothing here is modified after the build
except by `tools/build-vendor.mjs`, which regenerates the bundle.

## Vendored WebAssembly and JavaScript

### `vendor/sunvox/` — SunVox library 2.1.4d

Powered by SunVox (modular synth & tracker), Copyright (c) 2008–2026 Alexander
Zolotov, WarmPlace.ru. The runtime is unmodified; its own notices, including
the SunDog (MIT), Tremor (BSD-3-Clause) and libFLAC (BSD-3-Clause) texts, are in
`vendor/sunvox/THIRD-PARTY-NOTICES.txt` and `vendor/sunvox/LICENSE.txt`.

### `vendor/spessasynth/spessasynth.js` — the SoundFont synth

One import-free classic script (an esbuild IIFE, global `StudioSpessa`) that
bundles these three packages, each at the version its banner names:

| Package | Version | Licence | Licence text |
|---|---|---|---|
| `spessasynth_core` | 4.4.x | Apache-2.0 | `vendor/spessasynth/LICENSE-spessasynth_core.txt` |
| `fflate` | 0.8.x | MIT | `vendor/spessasynth/LICENSE-fflate.txt` |
| `stb-vorbis` | 0.0.x | Apache-2.0 | `vendor/spessasynth/LICENSE-stb-vorbis.txt` |

`spessasynth_core` — a MIDI and SoundFont2/SoundFont3 (SF2/SF3) library — is
Copyright (c) spessasus and contributors, licensed under the Apache License,
Version 2.0. `fflate`, a DEFLATE implementation, is Copyright (c) Arjun Barrett,
released under the MIT licence (reproduced below). `stb-vorbis`, a synchronous
Ogg Vorbis decoder (a WebAssembly build of `stb_vorbis` by Sean Barrett and
contributors, wrapped by spessasus), is licensed under the Apache License,
Version 2.0.

Both Apache-2.0 packages are distributed WITHOUT WARRANTIES OR CONDITIONS OF
ANY KIND, either express or implied; see their licence texts for the full terms.

Rebuild or verify with `node bundles/studio/tools/build-vendor.mjs` and
`node bundles/studio/tools/build-vendor.mjs --check` (CI runs the latter).

#### fflate — MIT

```
MIT License

Copyright (c) 2026 Arjun Barrett

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

## Downloaded instruments (not shipped in the bundle)

The catalog (`library/catalog.json`) lists the SoundFonts Crow can fetch into
`<CROW_HOME>/studio/library/`. They are downloaded by the operator, not
redistributed in this bundle, and each one's credit and licence is shown in the
instrument picker and in a render's metadata:

- **MuseScore General** (`MuseScore_General.sf3`) — MIT. MuseScore_General by
  S. Christian Collins, from FluidR3Mono by Michael Cowgill and FluidR3 by Frank
  Wen; Temple Blocks by Ethan Winer; Drumline Cymbals by Michael Schorsch. The
  upstream licence says the acknowledgements and copyright notices above must
  be included in any derivative work, so they are repeated here:

  > FluidR3 (original version) by Frank Wen Copyright (c) 2000-02
  >
  > Mono conversion (FluidR3Mono) by Michael Cowgill Copyright (c) 2014-17
  >
  > Adaptation for MuseScore_General.sf2 by S. Christian Collins Copyright
  > (c) 2018-19
  >
  > Temple Blocks instrument provided by Ethan Winer Copyright (c) 2002
  >
  > Drumline Cymbals provided by Michael Schorsch Copyright (c) 2016
  >
  > MuseScore_General.sf2 is shared under the MIT license as described in
  > COPYING, as was FluidR3Mono and FluidR3 before it.

  The MIT terms it refers to are the same as fflate's above, with those
  copyright holders in place of Arjun Barrett.