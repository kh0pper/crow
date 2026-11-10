# Starter sounds shipped with Crow Studio

Every file in this directory is shipped **unmodified**, and its size and sha256
are pinned in `../bundled.json`: the library file route and a render both hash
the bytes before anything plays them, so a file that no longer matches its record
is refused rather than played.

A starter sound reaches a song only when the person at the Studio page adds it
(there is no agent tool for that). The picker shows the `credit` line of every
entry beside the sound, and a render lists the credits of the sounds it heard.

## `starter-a2.nam` — the starter capture

- **What it is:** the A2 example model of the NeuralAmpModelerCore repository,
  shipped under a neutral name and credited below. It is a NAM A2 model, which
  is the only NAM format Studio plays.
- **Source:** <https://github.com/sdatkinson/NeuralAmpModelerCore/blob/main/example_models/A2.nam>
- **Licence:** MIT. Copyright (c) 2023 Steven Atkinson.
- **Credit line (as shown in the picker):** "NAM example A2 model by Steven
  Atkinson (NeuralAmpModelerCore), MIT".
- **Unmodified:** yes, byte for byte.
- **Source gear:** **unknown.** This is a training example, not a capture of a
  named amplifier. Studio therefore gives it no amplifier brand name; it is
  called a starter capture and nothing more.

### The MIT licence, in full (as it applies to `starter-a2.nam`)

```
MIT License

Copyright (c) 2023 Steven Atkinson

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

## The five starter cabinets

All five come from **"Impulse Responses" by David Fau Casquel**
(<https://archive.org/details/ImpulseResponses>), licensed **CC BY 3.0**
(<https://creativecommons.org/licenses/by/3.0/>). They are shipped
**unmodified**, at 24-bit stereo and 44.1 kHz, 44101 frames each (one frame over
exactly one second; the cabinet length check allows two frames of tolerance at
the file's own rate for exactly this reason). The credit line shown in the picker
is:

> "Impulse Responses" by David Fau Casquel
> (archive.org/details/ImpulseResponses), CC BY 3.0

| File | Upstream name | Display name | sha256 |
|---|---|---|---|
| `cabinet-ampmix.wav` | `AmpMix.wav` | Cabinet 1 (AmpMix) | `08bfb52f8699632ecbf7a602dc284327b9a19e6e403b86d6cc42f4d71bda4836` |
| `cabinet-ampmix2.wav` | `AmpMix2.wav` | Cabinet 2 (AmpMix2) | `8951e386bbeb97b03b4b1967e96f11477f697f449c5e2748fa0648c21c849764` |
| `cabinet-axhom.wav` | `Axhom.wav` | Cabinet 3 (Axhom) | `e8b798a01281de27e2daba689e71ad2cbd4ea8c5cb9605bc73efb7c84924e77a` |
| `cabinet-bestplugins.wav` | `Bestplugins.wav` | Cabinet 4 (Bestplugins) | `deef54911626805d592abc96d7c1f3c9b682aee79ba524a6556b9fe81664fc4e` |
| `cabinet-mixxx.wav` | `mixxx.wav` | Cabinet 5 (Mixxx) | `e645124084b67cf7d6da2e32040e5245bd90c32227773fd2f056ed1653bb24aa` |

Each is 264710 bytes.

The CC BY 3.0 licence asks for attribution and a link to the licence; the legal
code in full is at <https://creativecommons.org/licenses/by/3.0/legalcode>.

### The sixth file of that set is deliberately not shipped

The upstream set also holds `Bestplugins2.wav`, which is 1.17 s long — over the
one-second cabinet limit Studio enforces — so it is **not** part of the starter
set and is not in this bundle.

## No trained starter tones

This PR ships no capture Crow trained itself. The starter capture above is a NAM
example model; Crow's own captures arrive later, recorded from the operator's own
amplifier.