#!/usr/bin/env bash
# build-pet-linux.sh — Build the Crow pet-mode AppImage from the pinned
# upstream Open-LLM-VTuber-Web submodule.
#
# Phase 3.0 status: SKELETON. The flow below is wired end-to-end but
# exits early unless CROW_PET_BUILD_ENABLE=1 is set. Phase 3.1 flips the
# default and lands the actual patch hunks.
#
# Usage:
#   bundles/companion/scripts/build-pet-linux.sh
#   CROW_PET_BUILD_ENABLE=1 bundles/companion/scripts/build-pet-linux.sh
#
# Idempotent: safe to re-run. Re-applies patches from scratch each run
# by resetting the submodule to its pinned SHA before applying.

set -euo pipefail

# --- Resolve paths -----------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${BUNDLE_DIR}/../.." && pwd)"
SUBMODULE_DIR="${REPO_ROOT}/vendor/open-llm-vtuber-web"
PATCH_DIR="${BUNDLE_DIR}/patches/web"
OUT_DIR="${HOME}/.crow/bin"
OUT_PATH="${OUT_DIR}/open-llm-vtuber.AppImage"

log() { printf '[build-pet-linux] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# --- Phase 3.0 guard ---------------------------------------------------
if [[ "${CROW_PET_BUILD_ENABLE:-0}" != "1" ]]; then
  log "Phase 3.0 scaffold — skeleton only."
  log "Set CROW_PET_BUILD_ENABLE=1 to attempt the real build (Phase 3.1+)."
  log "Dry-running the flow now for verification:"
fi

# --- Preflight ---------------------------------------------------------
[[ -d "${SUBMODULE_DIR}" ]] || die "submodule missing: ${SUBMODULE_DIR} (run: git submodule update --init vendor/open-llm-vtuber-web)"
[[ -d "${PATCH_DIR}" ]]    || die "patch dir missing: ${PATCH_DIR}"
command -v git >/dev/null  || die "git not on PATH"
command -v node >/dev/null || die "node not on PATH"
command -v npm >/dev/null  || die "npm not on PATH"

# --- Step 1: reset + sync submodule to its pinned SHA -----------------
log "step 1/4: syncing submodule to pinned SHA"
(
  cd "${REPO_ROOT}"
  git submodule sync --recursive -- vendor/open-llm-vtuber-web
  git submodule update --init --force --recursive vendor/open-llm-vtuber-web
)
(
  cd "${SUBMODULE_DIR}"
  # Reset to pinned SHA (abandons any uncommitted patch artifacts).
  git reset --hard HEAD
  git clean -fdx
)

# --- Step 2: apply patches in numeric order ---------------------------
log "step 2/4: applying Crow patches from ${PATCH_DIR}"
shopt -s nullglob
PATCHES=("${PATCH_DIR}"/web-*.patch)
shopt -u nullglob
[[ ${#PATCHES[@]} -gt 0 ]] || die "no patches found in ${PATCH_DIR}"

# Sort by leading numeric prefix.
IFS=$'\n' PATCHES_SORTED=($(printf '%s\n' "${PATCHES[@]}" | sort))
unset IFS

for patch in "${PATCHES_SORTED[@]}"; do
  log "  applying $(basename "${patch}")"
  if [[ "${CROW_PET_BUILD_ENABLE:-0}" != "1" ]]; then
    log "    (skeleton: skipped — Phase 3.1 will finalize hunks and apply)"
    continue
  fi
  (
    cd "${SUBMODULE_DIR}"
    # --3way: graceful fallback if the patch doesn't apply cleanly
    # against a bumped submodule SHA, so an operator can rebase.
    git apply --3way --whitespace=nowarn "${patch}"
  )
done

# --- Step 3: npm ci + electron-builder --------------------------------
log "step 3/4: npm ci + electron-builder (Linux AppImage)"
if [[ "${CROW_PET_BUILD_ENABLE:-0}" != "1" ]]; then
  log "  (skeleton: skipped — Phase 3.1 runs npm ci and build:linux)"
else
  (
    cd "${SUBMODULE_DIR}"
    npm ci
    # Prefer the upstream-defined script; fall back to electron-builder CLI.
    if npm run --silent build:linux --if-present; then
      :
    else
      npx electron-builder --linux AppImage
    fi
  )
fi

# --- Step 4: copy AppImage to ~/.crow/bin/ ----------------------------
log "step 4/4: installing AppImage to ${OUT_PATH}"
mkdir -p "${OUT_DIR}"
if [[ "${CROW_PET_BUILD_ENABLE:-0}" != "1" ]]; then
  log "  (skeleton: skipped — Phase 3.1 copies dist/*.AppImage here)"
else
  DIST_DIR="${SUBMODULE_DIR}/dist"
  APPIMAGE="$(ls -1 "${DIST_DIR}"/*.AppImage 2>/dev/null | head -n1 || true)"
  [[ -n "${APPIMAGE}" ]] || die "no AppImage produced in ${DIST_DIR}"
  install -m 0755 "${APPIMAGE}" "${OUT_PATH}"
  log "installed: ${OUT_PATH}"
fi

log "done."
