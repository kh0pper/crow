#!/usr/bin/env bash
# build-pet-linux.sh — Build the Crow pet-mode AppImage from the pinned
# upstream Open-LLM-VTuber-Web submodule.
#
# Phase 3.1: runs end-to-end by default. Set CROW_PET_PATCH_ONLY=1 to
# stop after applying patches (useful for rebasing against a newer
# submodule SHA).
#
# Usage:
#   bundles/companion/scripts/build-pet-linux.sh
#   CROW_PET_PATCH_ONLY=1 bundles/companion/scripts/build-pet-linux.sh
#
# Idempotent: safe to re-run. Resets the submodule to its pinned SHA
# before applying patches.

set -euo pipefail

# --- Resolve paths -----------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${BUNDLE_DIR}/../.." && pwd)"
SUBMODULE_DIR="${REPO_ROOT}/vendor/open-llm-vtuber-web"
PATCH_DIR="${BUNDLE_DIR}/patches/web"
OUT_DIR="${HOME}/.crow/bin"
OUT_PATH="${OUT_DIR}/open-llm-vtuber.AppImage"
PATCH_ONLY="${CROW_PET_PATCH_ONLY:-0}"

log() { printf '[build-pet-linux] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

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
  name="$(basename "${patch}")"
  # Skip intentionally empty patches (0006 persona-swap).
  if ! grep -q '^diff --git' "${patch}"; then
    log "  skipping ${name} (no hunks — reserved slot)"
    continue
  fi
  log "  applying ${name}"
  (
    cd "${SUBMODULE_DIR}"
    # --3way: graceful fallback if the patch doesn't apply cleanly
    # against a bumped submodule SHA, so an operator can rebase.
    git apply --3way --whitespace=nowarn "${patch}"
  )
done

if [[ "${PATCH_ONLY}" == "1" ]]; then
  log "CROW_PET_PATCH_ONLY=1 — stopping after patch apply."
  exit 0
fi

# --- Step 3: npm install + electron-builder ---------------------------
# Use `npm install` (not `npm ci`) because patch 0001 removes the
# electron-updater dep from package.json without touching the lock;
# npm ci would fail on the resulting mismatch.
log "step 3/4: npm install + electron-builder (Linux AppImage)"
(
  cd "${SUBMODULE_DIR}"
  npm install --no-audit --no-fund --loglevel=error
  # Prefer the upstream-defined script; fall back to electron-builder CLI.
  if npm run --silent build:linux --if-present 2>/dev/null; then
    :
  else
    npx electron-builder --linux AppImage
  fi
)

# --- Step 4: copy AppImage to ~/.crow/bin/ ----------------------------
log "step 4/4: installing AppImage to ${OUT_PATH}"
mkdir -p "${OUT_DIR}"
# electron-builder writes into release/${version}/; also check dist/ as a fallback.
APPIMAGE="$(find "${SUBMODULE_DIR}/release" "${SUBMODULE_DIR}/dist" -name '*.AppImage' 2>/dev/null | head -n1 || true)"
[[ -n "${APPIMAGE}" ]] || die "no AppImage produced under ${SUBMODULE_DIR}/release or dist"
install -m 0755 "${APPIMAGE}" "${OUT_PATH}"
log "installed: ${OUT_PATH} ($(du -h "${OUT_PATH}" | cut -f1))"

log "done."
