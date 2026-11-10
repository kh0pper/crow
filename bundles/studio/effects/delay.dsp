// Crow Studio — the chain's delay (plan 1d, Task 7).
//
// A stereo, zero-latency insert: two independent delay lines (no cross-feed,
// so a hard-panned source stays where it is), each with a feedback loop through
// a one-pole low-pass so repeats darken as they decay, and a dry/wet mix.
//
// The delay itself is Faust's `de.fdelay` — a two-tap fractional delay line from
// the delay library — sized once for the document's longest time (2 s). The
// low-pass is `fi.lowpass` (STK-4.3, permissive; the build's licence lint checks
// that on every compile).
//
// `mix` 0 is the dry signal alone and 1 the echoes alone, as the document's
// range says.
//
// Parameter names, ranges and defaults are FINAL: they are the document's, and
// a test compares this file's compiled controls with `EFFECT_PARAMS`.
declare name "crow-studio-delay";

import("stdfaust.lib");

time_ms = hslider("time_ms", 375, 1, 2000, 1);
feedback = hslider("feedback", 0.35, 0, 0.95, 0.001);
mix = hslider("mix", 0.3, 0, 1, 0.001);
highcut_hz = hslider("highcut_hz", 8000, 1000, 20000, 1);

// The line is sized for the longest time the document allows, at this host's
// rate: 2 s plus the interpolator's own taps.
MAX_DELAY = int(ma.SR * 2.0) + 4;

// One channel: the dry signal, and the feedback echo scaled by the mix.
mono = _ <: *(1 - mix), (echo : *(mix)) :> _
with {
    echo = + ~ (de.fdelay(MAX_DELAY, time_ms * 0.001 * ma.SR)
              : fi.lowpass(1, highcut_hz)
              : *(feedback));
};

process = _,_ : par(i, 2, mono) : _,_;