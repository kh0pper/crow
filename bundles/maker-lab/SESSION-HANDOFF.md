# Maker Lab — Session Handoff (Phases 3.0–3.3, 4, 4b, 5-v0.1, and pet-mode CI closed)

## Where we are

Ten commits landed on `main` since the last handoff, all **pushed** to origin/main:

```
a12e39f Phase 5 v0.1 — Maker Lab Advanced bundle (JupyterHub for 9+)
a4b3e41 Phase 3 CI — nightly pet-mode AppImage rebuild
08d9ec3 Phase 4b — Maker Lab auto-detects vLLM (and Ollama) LLM endpoint
fbc7f73 Phase 4 — vLLM classroom inference bundle; GCompris dropped
0857a95 Phase 4 — Scratch (Offline) bundle (age 8+ step-up from Blockly)
66639ac Phase 4 — Kolibri learning platform bundle
7067cea Companion: Phase 3.3 — re-anchor running pet via Unix-socket control channel
ab2fd8f Companion: Phase 3.2 — honor CROW_PET_ANCHOR on launch, default bottom-right
c636ba0 Companion: Phase 3.1 — finalize pet-mode patches, build AppImage, wire crow_wm
18fb658 Companion: Phase 3.0 — pet-mode Electron foundation
```

Branch: `main`. Submodule `vendor/open-llm-vtuber-web` pinned at `d176e7df2366952e3bacbf12cf9a8b18a4315932`. AppImage at `~/.crow/bin/open-llm-vtuber.AppImage` (179 MB).

The Maker Lab initiative now has a complete age ladder (Blockly 5-9 → Scratch 8+ → Jupyter 9+), a content spine (Kolibri), a classroom inference engine (vLLM, auto-wired), a pet-mode build pipeline with CI, and a runtime re-anchor protocol.

## Your scope this session: close the Phase 3 / Phase 4 loose ends

Five concrete items remain. They're small and independent — pick any order, or do them all in sequence.

### 1. Pet-mode kill-switch (~15 min)
Wire a manifest-level `companion.pet_mode: false` flag so an operator can disable pet-mode cleanly. `crow_wm open pet` should return a friendly "pet mode disabled on this install" error instead of spawning the AppImage.

- Read the flag from `bundles/companion/manifest.json` at gateway startup (or Maker Lab startup — operator's call).
- Respect it in `servers/wm/server.js`'s `launchPet()` — early return with the kill-switch message.
- Default: `true` on Linux x86_64, `false` elsewhere (non-Linux platforms have no AppImage anyway).
- An env override (`CROW_PET_MODE=false`) for quick operator toggling without manifest edits is a nice-to-have.

**Acceptance:** With the flag set to `false`, `crow_wm open pet` returns `{action:"error","message":"Pet mode is disabled on this install..."}` and no AppImage spawns.

### 2. "Add more surfaces" card in the maker-lab panel (~30 min)
Plan line 341 explicitly says: *"maker-lab advertises these as recommended siblings in its panel's 'Add more surfaces' card; install goes through existing /bundles/api/install (line 549 of servers/gateway/routes/bundles.js)."*

Currently the maker-lab panel (`bundles/maker-lab/panel/maker-lab.js`) has **no sibling advertisement**. Add:

- A card in the maker-lab panel listing Kolibri, Scratch (Offline), Maker Lab Advanced, and vLLM with one-line descriptions and install/launch buttons.
- Each button POSTs to `/bundles/api/install` with the bundle id. Existing endpoint, no new routes.
- Hide bundles that are already installed (query `~/.crow/installed.json` or the gateway's bundle status endpoint). Replace "Install" with "Open ↗" for installed bundles.
- Respect the age gate: Scratch surfaces only when the current learner's age ≥ 8; Maker Lab Advanced only when ≥ 9.

**Acceptance:** Opening `/dashboard/maker-lab` when no siblings are installed shows 4 install cards. After installing Kolibri via the card, the next load shows Kolibri as an "Open Kolibri ↗" launch link instead.

### 3. Cubism SDK first-fetch + acceptance UX (~30-45 min)
Phase 3 shipped `bundles/companion/CUBISM-LICENSE.md` as the plain-language summary, but the actual in-app UX is missing: first pet-mode launch should show a dialog with the Live2D license summary + "I accept — download the SDK" / "Cancel — disable pet mode" buttons, then fetch the SDK into `~/.crow/cache/cubism/`.

- This is an Electron main-process change → **patch 0009** against `vendor/open-llm-vtuber-web`.
- SDK URL: `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`
- SHA-256 to verify: `942783587666a3a1bddea93afd349e26f798ed19dcd7a52449d0ae3322fcff7c`
- On pet-mode entry, check for cached SDK. If missing → show `electron.dialog.showMessageBox` with the license summary. On accept → fetch, verify SHA, cache under `~/.crow/cache/cubism/live2dcubismcore.min.js`, continue. On cancel → dismiss pet mode, show web-tiled mode.
- **SHA verification is not optional.** A mismatch refuses to load and surfaces an error dialog pointing at Live2D's SDK manual-download page.
- Rebuild the AppImage after the patch lands (use `bundles/companion/scripts/build-pet-linux.sh`). Phase 3 CI will also rebuild automatically on push.

**Acceptance:** Delete `~/.crow/cache/cubism/` → launch pet mode → see acceptance dialog. Click accept → SDK downloads (~130 KB), SHA verifies, pet loads. Second launch → dialog does NOT appear (SDK is cached).

### 4. Scratch trademark posture (~10 min)
Plan open item (line 353): *"Confirm Scratch self-host licensing for the bundle (MIT for the GUI repo, but trademark on 'Scratch' — use 'Scratch-compatible' branding)."*

Current manifest display name is literally "Scratch (Offline)". Per Scratch Foundation's Terms of Use, third-party projects running the `scratch-gui` code should avoid implying official endorsement.

- Rename the display name in `bundles/scratch-offline/manifest.json` and the registry entry to **"Offline Block Coding (Scratch-compatible)"** (or similar wording — operator's call on the exact phrasing).
- **Keep the bundle id** `scratch-offline` (don't rename the directory; URL paths are op-visible and shouldn't churn).
- Update the skill + panel to say "Scratch-compatible" where "Scratch" is used as a product name. Keep "Scratch" when referring to the ecosystem itself (e.g., "Scratch projects save as `.sb3`" is fine).
- Add a note that this is an independent self-hosted deployment of the open-source `scratch-gui` code, not an official Scratch Foundation product.

**Acceptance:** `grep -rn "Scratch" bundles/scratch-offline/` — product-name uses carry the "Scratch-compatible" qualifier or a clear independent-deployment disclaimer.

### 5. Phase 5 v0.2 — admin bootstrap automation (~45-60 min, optional)
Phase 5 v0.1 defers admin-account seeding to the UI. For a smoother install story:

- Write `bundles/maker-lab-advanced/scripts/bootstrap-admin.sh` (or a Python helper) that runs inside the container on first launch to create the admin account via NativeAuthenticator's Python ORM. I pulled speculative seeding code from `jupyterhub_config.py` in v0.1 because NA's API shape varies across versions — **verify the actual API by reading `nativeauthenticator/orm.py` in the pinned version first**, then write the seeding code.
- Call the script from `docker-compose.yml`'s command (wrap the existing `pip install + jupyterhub` chain).
- Must be idempotent — re-running on a hub that already has the admin user is a no-op.

**Acceptance:** `docker compose down && docker compose up -d` on a fresh install → no manual signup required; admin logs in immediately with `MLA_ADMIN_USER` + `MLA_ADMIN_PASSWORD`.

## What's NOT in scope

Hardware-gated items, explicitly deferred:
- **Pi 5 smoke test** — no Pi 5 available right now.
- **ChromeOS/Crostini smoke test** on penguin — needs Crostini display config.
- **`maker_hint` audio through the pet** (vs. browser audio) — needs a real pet-mode session with speakers.

## Working environment

- Repo: `/home/kh0pp/crow`, branch `main`.
- **Branch watchout**: parallel work on `f3-matrix-dendrite-bundle`, `f4-funkwhale-bundle`, `f5-pixelfed-bundle`, `f6-lemmy-bundle`, `f7-mastodon-bundle`, `f8-peertube-bundle`, `f11-identity-attestation` has been active. The branch **auto-switched out from under me ~8 times** during the previous session. **Before every commit**, run `git branch --show-current` and `git checkout main` if needed. When the switch leaves uncommitted mods on another branch's tracked files, `git stash push -m "<label>" <file>` those files specifically — not `git stash` everything, because some of those "modifications" are other branches' legitimate WIP.
- **Linter watchout**: `bundles/maker-lab/panel/routes.js` line ~347 keeps getting reverted to `/kiosk/blockly/*` (broken bare Express 5 wildcard). The correct form is `/kiosk/blockly/*asset`. Pre-commit: `grep kiosk/blockly bundles/maker-lab/panel/routes.js` should show `*asset`. If reverted, re-apply and commit immediately.
- **Two gateways**: restart BOTH on server-code changes:
  ```bash
  echo '<SUDO>' | sudo -S systemctl restart crow-gateway.service crow-mcp-bridge.service
  ```
  Sudo password in `~/.claude/secrets.md`. Both must be restarted or stale code runs.
- **Companion container** image `crow-companion` — if you need to rebuild (unlikely for this scope):
  ```bash
  cd bundles/companion
  docker compose build
  docker compose up -d --force-recreate
  ```
- **Stage by name, never `git add .`** — active WIP across f-branches litters the working tree with `bundles/campaigns/`, `bundles/coturn/`, `bundles/crowclaw/`, etc. that aren't this scope's work.
- **Don't force-push. Do push to `main` when each item is verified + committed** — user has authorized that pattern.

## Reference material

- **Plan**: `~/.claude/plans/vast-orbiting-fiddle.md` — exit criteria around line 320, open items around line 350.
- **Phase 0 report**: `bundles/maker-lab/PHASE-0-REPORT.md` — Cubism CDN URL + SHA pin (Spike 4); vLLM vs Ollama benchmark (Spike 5).
- **Patches**: `bundles/companion/patches/web/` — 8 slots, 6 active + 1 empty + 1 reserved; README has the apply/rebase/bump workflow.
- **Recently landed bundles** that followed the registry + superpowers + CLAUDE.md pattern: `bundles/kolibri/`, `bundles/scratch-offline/`, `bundles/vllm/`, `bundles/maker-lab-advanced/`.
- **Bundle checklist memory**: `~/.claude/projects/-home-kh0pp-crow/memory/feedback_new_bundle_checklist.md` — registry + category + nav-registry steps.

## Verification after each item

```bash
# Branch guard
git branch --show-current                                    # must be 'main'
grep kiosk/blockly bundles/maker-lab/panel/routes.js         # must contain '*asset'

# Submodule still pinned
git submodule status | grep open-llm-vtuber-web              # must show d176e7d

# All patches still apply cleanly
CROW_PET_PATCH_ONLY=1 bash bundles/companion/scripts/build-pet-linux.sh | tail -3

# Gateways healthy
curl -s -o /dev/null -w "gateway: %{http_code}\n" http://localhost:3002/health
curl -s -o /dev/null -w "kiosk:   %{http_code}\n" http://localhost:3004/kiosk/

# If you touched registry/add-ons.json:
node -e "JSON.parse(require('fs').readFileSync('registry/add-ons.json','utf8')); console.log('JSON OK')"

# Maker Lab engine resolution (should remain working through any edits)
curl -s http://localhost:3002/maker-lab/api/engine
```

Commit message prefixes to use: `Phase 3: pet-mode kill-switch`, `Phase 4: maker-lab siblings card`, `Phase 3: Cubism acceptance UX`, `Phase 4: Scratch trademark posture`, `Phase 5 v0.2: admin bootstrap automation`.

Good luck. Scope is still strict — if anything runs long, hand off again rather than creeping.
