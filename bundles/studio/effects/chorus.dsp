// Crow Studio — the chain's chorus (plan 1d, Task 7).
//
// A stereo, zero-latency insert: one short modulated delay per channel, swept
// by a sine LFO, mixed back with the dry signal. The two channels are a quarter
// of a cycle apart, which is what makes the effect wide rather than a vibrato.
//
// Faust's library has no chorus function of its own (the reverb library's
// `vital_rev` carries one internally), so this is four lines of Faust built on
// primitives and the delay library: the LFO is `os.lf_sawpos` (a phasor that
// does not drift) turned into a sine by hand, and the delay is `de.fdelay`, a
// two-tap fractional delay line — a chorus needs the delay to move smoothly,
// and a fractional read is what makes that smooth.
//
// The sweep is 12 ms of delay moving by up to 8 ms: the classic range that
// thickens a source without sounding like a pitch bend.
//
// Parameter names, ranges and defaults are FINAL: they are the document's, and
// a test compares this file's compiled controls with `EFFECT_PARAMS`.
declare name "crow-studio-chorus";

import("stdfaust.lib");

rate_hz = hslider("rate_hz", 0.8, 0.05, 5, 0.001);
depth = hslider("depth", 0.5, 0, 1, 0.001);
mix = hslider("mix", 0.5, 0, 1, 0.001);

BASE_DELAY_SECONDS = 0.012;
SWEEP_SECONDS = 0.008;

// The line is sized for the longest delay the sweep can ask for, plus the
// interpolator's own taps.
MAX_DELAY = int(ma.SR * (BASE_DELAY_SECONDS + SWEEP_SECONDS)) + 4;

// A sine between 0 and 1, `phase` cycles behind the LFO.
swing(phase) = 0.5 + 0.5 * sin(2 * ma.PI * ma.frac(os.lf_sawpos(rate_hz) + phase));

// One channel: the dry signal, and the swept delay scaled by the mix.
channel(phase) = _ <: *(1 - mix),
                 (de.fdelay(MAX_DELAY, (BASE_DELAY_SECONDS + depth * SWEEP_SECONDS * swing(phase)) * ma.SR)
                  : *(mix))
                 :> _;

process = _,_ : par(i, 2, channel(i * 0.25)) : _,_;