// The licence lint's AGPL fixture (plan 1d, Task 7): a Faust program that
// compiles and that Crow may NOT ship.
//
// `ba.processArray` and `ba.tabulateNd` in Faust's basics library are
// AGPL-3.0-only — a stricter licence than the GPL-only compressors, and one the
// lint must refuse just the same. The compiled meta carries
//
//   {"basics.lib/processArray:license": "AGPL-3.0-only"}
//
// The program is the library's own documented example, cut down to two parallel
// copies so it compiles fast.
declare name "crow-agpl-fixture";

import("stdfaust.lib");

processArray_proc(a, b, c) = a + b + c;

process = si.bus(2) : ba.processArray(2, processArray_proc, it.interpolate_linear, si.smoo, (0.1, 1.0), (1.0, 10.0));