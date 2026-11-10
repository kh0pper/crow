// Crow Studio — the chain's saturation (plan 1d, Task 7).
//
// A stereo, zero-latency insert: a drive gain into a cubic soft clipper, a tone
// control that rolls the clipped signal's top off, an output trim and a
// dry/wet mix.
//
// The clipper is the cubic soft clipper Faust's effect library describes
// (`ef.cubicnl` — the "Cubic Soft Clipper" curve): clip the driven signal to
// ±1, then `x - x³/3`, which is unity-sloped at zero and flattens towards the
// rails. Written here rather than called from the library so that `drive_db`
// is the dB of pre-gain the document says it is (the library function's own
// drive control is a 0..1 amount whose pre-gain is fixed at 10^(2·drive)), and
// so that the curve is scaled by 1.5 to reach ±1 at full scale.
//
// `tone` walks a one-pole low-pass from 400 Hz (dark) to 16 kHz (open), and
// `output_db` trims the result; the trim to −24 dB is there for a driven signal
// that needs taming, not to mute it.
//
// Parameter names, ranges and defaults are FINAL: they are the document's, and
// a test compares this file's compiled controls with `EFFECT_PARAMS`.
declare name "crow-studio-saturation";

import("stdfaust.lib");

drive_db = hslider("drive_db", 6, 0, 36, 0.1);
tone = hslider("tone", 0.5, 0, 1, 0.001);
output_db = hslider("output_db", 0, -24, 6, 0.1);
mix = hslider("mix", 1, 0, 1, 0.001);

// Pre-gain, the clipper, the tone stage and the output trim, all in one chain.
drive_gain = pow(10.0, drive_db / 20.0);
output_gain = pow(10.0, output_db / 20.0) * 1.5;

cubic(x) = x - x * x * x / 3.0;

saturate = *(drive_gain)
         : min(1) : max(-1)
         : cubic
         : fi.lowpass(1, 400.0 * pow(40.0, tone))
         : *(output_gain);

// One channel: the dry signal, and the saturated copy scaled by the mix.
mono = _ <: *(1 - mix), (saturate : *(mix)) :> _;

process = _,_ : par(i, 2, mono) : _,_;