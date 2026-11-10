// The licence lint's "permissive function that calls GPL code" fixture
// (plan 1d, Task 7 fix).
//
// `fi.avg_rect` declares STK-4.3 — a licence Crow may ship — but its body is
//
//   avg_rect(period, x) = x : ba.slidingMean(rint(period * ma.SR));
//
// and `ba.slidingMean` is GPL-3.0-only, declared only in a comment. So the
// compiled meta carries a permissive entry for the function Crow calls
// (`filters.lib/avg_rect:license = LicenseRef-STK-4.3`) and nothing at all
// about the GPL code underneath it: a declarations-only lint passes this
// program, which is exactly why the build keeps a denylist of the functions
// that call that code.
//
// `fi.avg_tau`, `fi.avg_t60` and `fi.avg_t19` are NOT in the same family — they
// are one-pole averages (`fi.lptau`/`fi.lpt60`/`fi.lpt19`) and pass.
//
// See tests/studio-faust-effects.test.js.
declare name "crow-gpl-caller-fixture";

import("stdfaust.lib");

process = _ : fi.avg_rect(0.01) <: _,_;