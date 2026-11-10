// Crow Studio — the chain's resonant filter (plan 1d, Task 7).
//
// A stereo, zero-latency insert: one resonant second-order section whose kind
// is the document's chooser (`lp`, `hp`, `bp`) and whose corner and Q are the
// other two controls. The three sections of `fi` are STK-4.3 (permissive — the
// build's licence lint checks that on every compile), and all three run every
// frame: the chooser multiplies each one by a 0/1 mask and the masks sum, which
// is one addition per frame and no branch a compiler cannot fold.
//
// The document's `mode` is a chooser, not a number, so this file exposes it as
// an integer control 0..2 (0 = lp, 1 = hp, 2 = bp) — the order of the
// document's `values`. `engine/faust-host.js` maps the word to that index, and a
// test holds the two lists together.
//
// Parameter names, ranges and defaults are FINAL: they are the document's, and
// a test compares this file's compiled controls with `EFFECT_PARAMS`.
declare name "crow-studio-filter";

import("stdfaust.lib");

mode = nentry("mode", 0, 0, 2, 1);
cutoff_hz = hslider("cutoff_hz", 1000, 20, 20000, 0.1);
resonance = hslider("resonance", 0.7, 0.1, 10, 0.001);

// `gain` is the pass-band gain of the section: unity, so the filter shapes the
// sound and does not change its level.
mono = _ <: (fi.resonlp(cutoff_hz, resonance, 1),
            fi.resonhp(cutoff_hz, resonance, 1),
            fi.resonbp(cutoff_hz, resonance, 1))
     : (*(mode == 0)), (*(mode == 1)), (*(mode == 2))
     :> _;

process = _,_ : par(i, 2, mono) : _,_;