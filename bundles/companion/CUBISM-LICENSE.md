# Live2D Cubism SDK — Plain-Language Summary

The AI Companion uses the Live2D Cubism SDK for Web to animate its mascot. The SDK
is owned by Live2D Inc. and published under the Live2D Proprietary Software License
(https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html).

What this means for you:

- The SDK is NOT bundled in this install. On first pet-mode entry the AppImage
  shows an acceptance dialog with this summary; on accept, it downloads the file
  (≈130 KB) from Live2D's CDN directly into `~/.crow/cache/cubism/`.
- The download is SHA-256-verified against a pinned hash
  (`942783587666a3a1bddea93afd349e26f798ed19dcd7a52449d0ae3322fcff7c`). A mismatch
  refuses to load and surfaces an error dialog pointing at Live2D's manual-download
  page.
- You — the end user — accept Live2D's license at download time. Crow does not act
  as a redistributor.
- If you decline, pet mode is disabled for that launch and the web-tiled window
  stays available. Declining does not download anything.
- Subsequent launches reuse the cached file silently; delete `~/.crow/cache/cubism/`
  to re-trigger the acceptance dialog.
- For air-gapped classrooms: manually download `live2dcubismcore.min.js` from
  https://www.live2d.com/en/sdk/download/web/ on an internet-connected machine and
  copy it into `~/.crow/cache/cubism/`. The SHA-256 check still runs — verify
  upstream distributes the pinned hash, or bump the pin after reviewing the new
  license terms.

Attribution (required by the Live2D agreement):

  Live2D Cubism SDK for Web © Live2D Inc.
