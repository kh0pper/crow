# Companion Web Patches (Open-LLM-VTuber-Web Electron app)

Patches against the upstream Electron/React web client
(`github.com/Open-LLM-VTuber/Open-LLM-VTuber-Web`), checked out as a
submodule at `vendor/open-llm-vtuber-web/` and pinned by SHA in
`.gitmodules`.

Status: all patches active (Phase 3.1+). `build-pet-linux.sh` applies
the series in numeric order against the pinned submodule SHA and
produces `~/.crow/bin/open-llm-vtuber.AppImage`.

## Patch slots

| Patch | Status | What it does |
|---|---|---|
| `web-0001-disable-auto-updater.patch` | active | Strip `electron-updater` wiring; Crow ships its own pinned AppImage. |
| `web-0002-linux-transparency-flags.patch` | active | Auto-apply `--enable-transparent-visuals --disable-gpu-compositing` on Linux when no compositor is detected. |
| `web-0003-multimonitor-positioning.patch` | active | Place pet-mode window on the display under the cursor instead of spanning the entire virtual screen. |
| `web-0004-crow-ipc-pet-position.patch` | active | Expose `ipcMain.handle('crow:pet-position', ...)` so the Crow gateway can anchor the pet window programmatically. |
| `web-0005-no-sandbox-fallback.patch` | active | Proactively append `--no-sandbox` on AppImage launches and log a visible warning. |
| `web-0006-persona-swap.patch` | **intentionally empty** | Spike 2 confirmed upstream `switch-config` handles per-connection persona; slot retained to keep numbering contiguous. |
| `web-0007-crow-pet-anchor-on-launch.patch` | active | Read `CROW_PET_ANCHOR` env var at launch, auto-switch to pet mode, apply anchor (right / left / bottom-right / bottom-left) with 320x480 pet-body defaults. |
| `web-0008-pet-control-socket.patch` | active | Unix-socket control channel at `$XDG_RUNTIME_DIR/crow-pet.sock` so the Crow gateway can re-anchor a running pet via `{op:"anchor",spec:...}` without respawning. |

## Applying

Patches are applied automatically by:

```bash
bundles/companion/scripts/build-pet-linux.sh
```

The script:

1. Runs `git submodule update --init --force vendor/open-llm-vtuber-web`
2. Resets the submodule to its pinned SHA and wipes any prior apply artifacts
3. Walks `bundles/companion/patches/web/web-*.patch` in sorted numeric order and
   applies each with `git apply --3way`
4. Runs `npm ci` + `npm run build:linux` (or `npx electron-builder --linux AppImage`)
5. Installs the resulting AppImage to `~/.crow/bin/open-llm-vtuber.AppImage`

Steps 2-5 are gated on `CROW_PET_BUILD_ENABLE=1` during Phase 3.0; Phase 3.1
flips the default.

## Rebasing onto a newer upstream SHA

When bumping the submodule pin:

```bash
# 1. Enter the submodule and fetch the target SHA
cd vendor/open-llm-vtuber-web
git fetch origin
git checkout <new-sha>
cd ../..

# 2. Dry-run each patch to see which still apply cleanly
for p in bundles/companion/patches/web/web-*.patch; do
  echo "=== $p ==="
  (cd vendor/open-llm-vtuber-web && git apply --check "../../$p") \
    && echo "  clean" \
    || echo "  NEEDS REBASE"
done

# 3. For each NEEDS REBASE patch:
#    - apply with `git apply --3way` to materialize conflict markers
#    - resolve in the working tree
#    - regenerate the patch with `git diff` and replace the file
#    - update the "Applies against: <sha>" header line

# 4. Commit the submodule bump + patch refreshes together
git add vendor/open-llm-vtuber-web bundles/companion/patches/web/
git commit -m "Companion: bump open-llm-vtuber-web to <new-sha>"
```

## Bumping the submodule SHA

The pinned SHA lives in two places that must stay in lockstep:

1. The submodule ref itself (update with `git checkout <sha>` inside the submodule,
   then commit the pointer bump in the parent repo).
2. The `Applies against:` header line in each patch file (documentation only; the
   apply script does not parse it, but reviewers rely on it).

## Related

- Python backend patches: `bundles/companion/patches/backend/` and its README
- Cubism SDK license posture: `bundles/companion/CUBISM-LICENSE.md`
- Phase plan: `~/.claude/plans/vast-orbiting-fiddle.md` (Phase 3 section)
- Phase 0 spike report: `bundles/maker-lab/PHASE-0-REPORT.md`
