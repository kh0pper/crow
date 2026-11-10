// Crow Studio — the chain's phaser (plan 1d, Task 7).
//
// A stereo, zero-latency insert built on `pf.phaser2_stereo` from Faust's
// phaser-and-flanger library: four all-pass notches swept between 220 Hz and
// 4 kHz, the two channels half a cycle apart, mixed back with the dry signal.
//
// The document has four controls; the sweep geometry is fixed: four notches
// (a stomp-box count), each notch a 1.5× step above the last, and 50 Hz of
// notch width. `depth` is the document's intensity (1 = the all-pass chain
// summed equally with the dry signal), `feedback` its loop gain, and `mix` the
// dry/wet balance — at 0 the phaser is bypassed, at 1 only its notched copy is
// heard.
//
// Parameter names, ranges and defaults are FINAL: they are the document's, and
// a test compares this file's compiled controls with `EFFECT_PARAMS`.
declare name "crow-studio-phaser";

import("stdfaust.lib");

rate_hz = hslider("rate_hz", 0.5, 0.05, 5, 0.001);
depth = hslider("depth", 0.6, 0, 1, 0.001);
feedback = hslider("feedback", 0.4, 0, 0.9, 0.001);
mix = hslider("mix", 0.5, 0, 1, 0.001);

NOTCHES = 4;

// phaser2_stereo(Notches, width, frqmin, fratio, frqmax, speed, depth, fb, invert)
phaser = pf.phaser2_stereo(NOTCHES, 50, 220, 1.5, 4000, rate_hz, depth, feedback, 0);

process = _,_ <: (par(i, 2, *(1 - mix)), (phaser : par(i, 2, *(mix)))) :> _,_;