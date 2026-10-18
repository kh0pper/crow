# Design kit — licences

Exact versions and per-file sha256 for everything in `lib/` are in `lib/manifest.json`; each entry names its licence text under `lib/licenses/`. **No non-commercial components.** Nothing in the kit is GPL, AGPL, SSPL or EPL code that is linked into Crow.

| Component | Licence | How it ships | Notes |
|---|---|---|---|
| Skills design-frontend, design-themes, design-poster (from anthropics/skills: frontend-design, theme-factory, canvas-design) | Apache-2.0 | `skills/` (modified, see `NOTICE`); originals in `third_party/anthropic-skills/` | `LICENSE.txt` kept per skill; `NOTICE` records the upstream commit and lists every change. The upstream repository ships no NOTICE file at that commit. |
| Theme CSS (`lib/themes/`, `lib/themes.json`) | Apache-2.0 | generated from theme-factory | Derived from the themes; see `NOTICE`. Licence text: `lib/licenses/anthropic-skills-theme-factory.txt`. |
| Ten font families: Lora, Crimson Pro, Young Serif, Instrument Serif, Work Sans, Outfit, Instrument Sans, Bricolage Grotesque, JetBrains Mono, IBM Plex Mono (the canvas-fonts families, packaged by @fontsource) | OFL-1.1 | `lib/font/`, woff2 (latin subset) | May be bundled and redistributed with software; may not be sold on their own. Each family's copyright line and the full OFL text are in `lib/licenses/font-<family>.txt`. |
| Lucide icons (lucide-static) | ISC | `lib/icons/lucide.json` | |
| Tabler icons (@tabler/icons, outline set) | MIT | `lib/icons/tabler.json` | |
| Open Props | MIT | `lib/css/open-props/` | |
| Pico CSS (@picocss/pico) | MIT | `lib/css/pico/` | Its banner is kept in `lib/licenses/css-pico-banner.txt`. |
| Vega, Vega-Lite, vega-embed | BSD-3-Clause | `lib/js/` (pages) and the renderer image | vega-embed's build carries vega-interpreter (BSD-3-Clause), the CSP-safe expression evaluator. |
| vega-interpreter | BSD-3-Clause | renderer image (and inside vega-embed's build for pages) | |
| Mermaid | MIT | `lib/js/mermaid/` (pages) and the renderer image | **Pinned to 11.x:** Mermaid 12.x bundles elkjs, which is EPL-2.0, outside this kit's licence list. |
| SunVox library (libsunvox JS+WASM build) | MIT | `lib/js/sunvox/` (pages only) | Vendored from a hash-pinned upstream archive (URL + sha256 in `lib/manifest.json` and `scripts/design-kit/pins.json`); © Alexander Zolotov (WarmPlace.ru). The glue and loader ship unmodified; the engine's WASM rides base64 inside the Crow-generated `lib/js/sunvox/sunvox-wasm.js`, because artifact pages are connect-src 'none' and nothing may be fetched at runtime. Licence text: `lib/licenses/sunvox.txt`. |
| D2 | MPL-2.0 | renderer image only: the unmodified release binary (version and sha256 in `renderer/Dockerfile` and `renderer/d2.sha256`) | A separate program, run as a process, never linked. Source: the d2 release tag of that version. |
| svgo | MIT | renderer image | |
| puppeteer-core | Apache-2.0 | renderer image | |
| Chromium (Debian package) | BSD-3-Clause and others (Debian's copyright file in the image) | renderer image | Unmodified distribution package; runs headless and offline. See *Chromium version* below. |
| Other Debian packages in the renderer image (fonts-dejavu-core, fonts-liberation, util-linux for `prlimit`, ca-certificates) | each package's own licence (Debian's copyright file under `/usr/share/doc/<package>/` in the image) | renderer image | Unmodified distribution packages, used as separate programs or data files. curl is installed only to download the D2 binary at build time and is purged in the same layer, so it is not in the image. |
| Node.js (base image) | MIT | renderer image | Pinned by digest in `renderer/Dockerfile`. |

## Reserved Font Names

Some OFL fonts declare a Reserved Font Name: **Lora** (Reserved Font Name "Lora") is one in this kit; check each `lib/licenses/font-<family>.txt` for the copyright line. The woff2 files here are subsets made by @fontsource, and a subset may count as a Modified Version under the OFL. A Modified Version may not be distributed under a Reserved Font Name, so if you rebuild, subset or otherwise change these files yourself, rename the family before you distribute it. The kit ships the @fontsource files unchanged, and the family names are the ones @fontsource publishes them under.

## Bundled third-party code

The minified Mermaid, Vega and vega-embed builds include code from their dependency trees (for example d3 modules, ISC; DOMPurify, MPL-2.0 OR Apache-2.0; chevrotain, Apache-2.0). These notices are not repeated here. Each such entry has a generated notices file, which lists every bundled package with its licence id and full licence text:

- `lib/licenses/mermaid-third-party.txt`
- `lib/licenses/vega-third-party.txt`
- `lib/licenses/vega-embed-third-party.txt`

`lib/manifest.json` names each entry's notices file (`notices`), and the notices file is copied into every artifact version that uses the entry, next to the entry's own licence.

## Renderer image dependencies

Licence ids in `renderer/package-lock.json` (production dependencies): MIT 96 (95 declared, plus `khroma@2.1.0`, which has no `license` field but ships the MIT text), ISC 41, BSD-3-Clause 40, BSD-2-Clause 7, Apache-2.0 5, CC0-1.0 2, (MPL-2.0 OR Apache-2.0) 1, 0BSD 1, BlueOak-1.0.0 1, Unlicense 1. No GPL, AGPL, SSPL or non-commercial licences.

## Chromium version

Chromium is **not pinned**, by decision. Debian ships it through its security archive, which keeps only the newest build, so a pinned `chromium=<version>` would stop building at the next security update. Accepted drift: each build installs Debian's current, patched Chromium, and the version that was installed is recorded in `/chromium-version.txt` inside the image.

## Licences travel with every copy

Each library entry's licence text (and its third-party notices) is copied into the artifact version under `__lib/licenses/` together with the files, so a version shared with a contact carries its notices.

## Source offer

The renderer image is built on the user's machine from upstream sources (Debian packages, the D2 release binary, npm packages), so Crow redistributes no prebuilt image. Publishing a prebuilt image would trigger the source-availability duties of MPL-2.0 (D2) and of the GPL-licensed Debian packages in it, and the Chromium notices; that is follow-up F3, not v1.
