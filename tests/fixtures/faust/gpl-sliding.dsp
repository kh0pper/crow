// The licence lint's "comment-only GPL" fixture (plan 1d, Task 7 fix).
//
// `basics.lib`'s Sliding Reduce section is GPL-3.0-only, and it says so in a
// COMMENT rather than in a `declare`:
//
//   // Section contributed by Bart Brouns (bart@magnetophon.nl).
//   // SPDX-License-Identifier: GPL-3.0
//   // Copyright (C) 2018 Bart Brouns
//
// so the compiled meta for the program below carries NO licence entry for
// `slidingMax` at all — the meta is silent, not permissive — and a lint that
// only reads declarations waves it through. This file exists so that hole is
// tested: the refusal has to come from the `.dsp` text, and it has to name the
// function and say the licence is declared only in a comment.
//
// See tests/studio-faust-effects.test.js.
declare name "crow-gpl-sliding-fixture";

import("stdfaust.lib");

process = ba.slidingMax(64, 128) <: _,_;