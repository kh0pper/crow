# Live2D Cubism SDK — Plain-Language Summary

The AI Companion uses the Live2D Cubism SDK for Web to animate its mascot. The SDK
is owned by Live2D Inc. and published under the Live2D Proprietary Software License
(https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html).

What this means for you:

- The SDK is NOT bundled in this install. On first launch the app downloads it from
  Live2D's CDN (≈130 KB) into ~/.crow/cache/cubism/.
- You — the end user — accept Live2D's license at download time. Crow does not act
  as a redistributor.
- If you opt out, pet-mode is disabled but web-tiled mode works without the SDK
  being downloaded.
- For air-gapped classrooms: a documented manual install script is planned (fetch
  the SDK on an internet-connected machine, copy into ~/.crow/cache/cubism/).

Attribution (required by the Live2D agreement):

  Live2D Cubism SDK for Web © Live2D Inc.
