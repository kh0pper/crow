// Crow Studio — the chain's three-band equalizer (plan 1d, Task 7).
//
// A stereo, zero-latency insert with the seven controls the song document holds
// (`EFFECT_PARAMS.eq` in server/doc.js): a low shelf, a peaking bell and a high
// shelf, each at its own corner frequency, with the bell's width set by a Q.
//
//   L/R -> low shelf -> peaking eq -> high shelf -> L/R
//
// The three sections are `fi.low_shelf`, `fi.peak_eq` and `fi.high_shelf` from
// Faust's filter library (STK-4.3, permissive — the build's licence lint
// checks that on every compile). `peak_eq` takes a bandwidth in Hz, so the
// document's Q becomes `freq / Q`.
//
// Parameter names, ranges and defaults are FINAL: they are the document's, and
// a test compares this file's compiled controls with `EFFECT_PARAMS`.
declare name "crow-studio-eq";

import("stdfaust.lib");

low_freq_hz = hslider("low_freq_hz", 100, 20, 500, 0.1);
low_gain_db = hslider("low_gain_db", 0, -18, 18, 0.1);
mid_freq_hz = hslider("mid_freq_hz", 1000, 100, 10000, 0.1);
mid_gain_db = hslider("mid_gain_db", 0, -18, 18, 0.1);
mid_q = hslider("mid_q", 0.7, 0.1, 10, 0.001);
high_freq_hz = hslider("high_freq_hz", 8000, 2000, 20000, 0.1);
high_gain_db = hslider("high_gain_db", 0, -18, 18, 0.1);

// One channel through the three sections. Every control is read once, at the
// top, so both channels share one control each.
mono = fi.low_shelf(low_gain_db, low_freq_hz)
     : fi.peak_eq(mid_gain_db, mid_freq_hz, mid_freq_hz / mid_q)
     : fi.high_shelf(high_gain_db, high_freq_hz);

process = _,_ : par(i, 2, mono) : _,_;