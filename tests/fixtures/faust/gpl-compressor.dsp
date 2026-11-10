// The licence lint's GPL fixture (plan 1d, Task 7): a Faust program that
// compiles and that Crow may NOT ship.
//
// Every `co.*` compressor and limiter in Faust's compressor library is
// GPL-3.0-only. `co.FFcompressor_N_chan` is the clearest one to name: the
// compiled meta carries
//
//   {"compressors.lib/FFcompressor_N_chan:license": "GPL-3.0-only"}
//
// so `lintMeta` refuses it, and the build refuses an effect that used it. This
// file exists only to be refused — see tests/studio-faust-effects.test.js.
declare name "crow-gpl-fixture";

import("stdfaust.lib");

process = co.FFcompressor_N_chan(1, -20, 0.01, 0.1, 6, 0, 1, _, 1);