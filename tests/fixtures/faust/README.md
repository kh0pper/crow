# Faust test fixtures

`gpl-compressor.dsp` and `agpl-process-array.dsp` are the licence lint's two
negative fixtures: each compiles, and each uses one Faust library function whose
licence Crow may not ship (GPL-3.0-only and AGPL-3.0-only). They exist so the
build's refusal is tested against real compiled metadata, not a hand-written
meta array.

Both are refused by `lintMeta` in `bundles/studio/tools/build-faust.mjs`, and
`tests/studio-faust-effects.test.js` pins that: the refusal names the function
and the licence, and the build refuses to write an effect that used one.