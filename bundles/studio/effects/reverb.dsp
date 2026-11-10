// Crow Studio — the chain's reverb (plan 1d, Task 7).
//
// A stereo insert built on `re.jpverb` from Faust's reverb library — an
// algorithmic reverb (MIT licensed, which is why it is the one this task ships:
// the library's other reverbs are STK-4.3 or GPL-3.0-only, and the 26 GPL-only
// functions are exactly what the build's licence lint exists to keep out). It
// is zero-latency, so it may sit on a track or a return.
//
// The document has four controls; jpverb has eleven:
//
//   size        steers the decay (t60, 0.5 s to 6 s) and the room (size,
//               0.5 to 3) together, because "a bigger room" is one idea to the
//               person turning the knob;
//   damping     is jpverb's own damping, held a hair below 1 so the tail cannot
//               freeze;
//   predelay_ms delays the reverb's input (a plain integer delay line, so the
//               dry signal stays exactly where it was);
//   mix         is the dry/wet balance, 0 = dry alone, 1 = wet alone.
//
// The remaining jpverb controls are constants: a smooth early build-up
// (0.8), a slow chorus in the tail (0.3 depth at 0.4 Hz), and the three
// band decay multipliers with their crossovers.
//
// Parameter names, ranges and defaults are FINAL: they are the document's, and
// a test compares this file's compiled controls with `EFFECT_PARAMS`.
declare name "crow-studio-reverb";

import("stdfaust.lib");

size = hslider("size", 0.5, 0, 1, 0.001);
damping = hslider("damping", 0.5, 0, 1, 0.001);
predelay_ms = hslider("predelay_ms", 20, 0, 200, 1);
mix = hslider("mix", 0.25, 0, 1, 0.001);

// The predelay line's size: the document's longest, in samples, at this rate.
MAX_PREDELAY = int(ma.SR * 0.2) + 4;

verb = re.jpverb(
    0.5 + size * 5.5,     // t60, seconds
    damping * 0.95,       // damping
    0.5 + size * 2.5,     // room size
    0.8,                  // early_diff
    0.3,                  // mod_depth
    0.4,                  // mod_freq, Hz
    0.9,                  // low band decay
    0.8,                  // mid band decay
    0.7,                  // high band decay
    500,                  // low/mid crossover, Hz
    4000);                // mid/high crossover, Hz

process = _,_ <: (par(i, 2, *(1 - mix)),
                  (par(i, 2, de.delay(MAX_PREDELAY, int(predelay_ms * 0.001 * ma.SR)))
                   : verb
                   : par(i, 2, *(mix))))
        :> _,_;