/**
 * Crow's Nest Panel — Studio.
 *
 * Two pages under `/dashboard/studio`:
 *
 *   - without `?song=`, the song library: the songs of every project (read
 *     with `GET /api/studio/songs`, optionally filtered by project) and the
 *     "New song" form, whose project picker is the instance's own live
 *     project spaces, read here from the dashboard's database;
 *   - with `?song=<id>`, one song's studio: the session grid (tracks as
 *     columns, scenes as rows), the clip editor, the transport, the shared
 *     history and the presence row.
 *
 * The page is a shell the client fills in. The handler knows nothing about
 * songs beyond their id: the session hub is what owns a song, the WebSocket in
 * server/web.js is how the page reads it, and `panel/client.js` is the script
 * that does both. Nothing dynamic is interpolated into HTML without
 * `escapeHtml`, and the client itself builds every node with `textContent`, so
 * a song title or a project name can never become markup.
 *
 * The client's Yjs build is an ES module that imports `lib0` by name, so the
 * page carries a small import map pointing `lib0/` at the bundle's own
 * copy, which server/web.js serves beside `yjs.mjs` from the asset whitelist.
 * That is the only reason this page has an import map.
 *
 * ## One import map per document (the Turbo limitation)
 *
 * A document may register exactly one import map, and only before its first
 * module load. A bundle's panel cannot write into the dashboard's `<head>`, so
 * this map travels in the body next to the script. Turbo never reloads a
 * document, so a Studio page reached by a Turbo visit cannot register the map
 * again: the browser refuses it, and Yjs's bare `lib0/...` imports may then
 * fail to resolve. There is no API to add or replace a registered map, so the
 * client treats a failed `import()` of `yjs.mjs` as "this page needs a real
 * load" and shows a Reload notice with a button that does
 * `location.reload()` (see `showReloadNotice` in panel/client.js).
 *
 * ## Where the client comes from
 *
 * A bundle's panel is loaded twice: from its own bundle directory in the
 * checkout, and as `<crow-home>/panels/studio.js`, a single-file copy beside
 * the gateway. A relative `import "./client.js"` would resolve to
 * `<crow-home>/panels/client.js` in the installed case, which is not there
 * (docs/developers/bundles.md), so the client is imported BY PATH from the
 * bundle directory — this file's own bundle first, then this instance's
 * installed copy, then the app root's.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** This file's directory (`<bundle>/panel`, or `<crow-home>/panels` when installed). */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * The Studio bundle directory this panel's client script is loaded from.
 *
 * The order matters: the bundle this file sits in wins (the checkout and a
 * refreshed installed bundle both satisfy it), then this instance's installed
 * copy, then the app root the gateway exports. CROW_HOME is honoured so a
 * co-hosted instance never reads another instance's bundle.
 * @returns {string|null} the bundle directory, or null when none has the
 *   client script
 */
function findBundleDir() {
  const home = process.env.CROW_HOME || join(homedir(), ".crow");
  const candidates = [
    resolve(here, ".."),
    join(home, "bundles", "studio"),
    process.env.CROW_APP_ROOT ? join(process.env.CROW_APP_ROOT, "bundles", "studio") : null,
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(join(dir, "panel", "client.js"))) return dir;
  }
  return null;
}

/**
 * Import one of the panel's inline scripts from the bundle directory.
 *
 * Both of them travel as strings and are emitted as their own `<script>` in the
 * page (see the file header for why a relative import would not resolve in the
 * installed case). `name` is a module file name inside `panel/`; `exportName`
 * is the string it must export.
 * @param {string} name e.g. "client.js"
 * @param {string} exportName e.g. "CLIENT_SCRIPT"
 * @returns {Promise<string>} the script the page carries
 * @throws {Error} when no bundle directory has the file, or it exports nothing
 */
async function loadPanelScript(name, exportName) {
  const dir = findBundleDir();
  if (!dir) {
    throw new Error("Studio panel: panel/client.js was not found in the bundle");
  }
  const module = await import(pathToFileURL(join(dir, "panel", name)).href);
  if (typeof module[exportName] !== "string" || module[exportName] === "") {
    throw new Error(`Studio panel: panel/${name} exports no ${exportName}`);
  }
  return module[exportName];
}

/** The client script, loaded once when the panel module is imported. */
const CLIENT_SCRIPT = await loadPanelScript("client.js", "CLIENT_SCRIPT");

/**
 * The local-first take store, loaded once: it must reach the page BEFORE the
 * client, because the client asks `window.StudioTakeStore` for the takes this
 * device kept.
 */
const TAKE_STORE_SCRIPT = await loadPanelScript("take-store.js", "TAKE_STORE_SCRIPT");

/**
 * Escape a value for use in HTML text or a double-quoted attribute.
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The studio look: dark studio tokens from the approved mockup (screen 1),
 * scoped under `.studio` so nothing leaks into the dashboard around it.
 *
 * Every primary control is at least 44 px tall (touch), and the grid scrolls
 * inside its own box, so the whole page works at phone width. The toast is the
 * only fixed layer: it sits at the bottom centre, never covering the viewport,
 * and at z-index 1200 — above the player bar and every dashboard layer.
 */
const STYLES = `
  .studio {
    --st-bg: #121417; --st-panel: #171A1D; --st-head: #1B1E22;
    --st-line: #2C3036; --st-line-soft: #23272C; --st-edge: #3A3F46;
    --st-text: #E9E6DF; --st-muted: #A9A59C;
    --st-human: #F2A541; --st-agent: #5DA9F0; --st-danger: #F07A6A;
    background: var(--st-bg); color: var(--st-text);
    border: 1px solid var(--st-line); border-radius: 12px;
    display: flex; flex-direction: column; gap: 0; overflow: hidden;
    font-family: Inter, system-ui, sans-serif;
  }
  .studio * { box-sizing: border-box; }
  .studio a { color: #8CC4F5; }
  .studio .st-bar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px;
    padding: 10px 14px; background: var(--st-head); border-bottom: 1px solid var(--st-line);
  }
  .studio .st-back { font-size: 13px; text-decoration: none; color: var(--st-muted); }
  .studio .st-title { font-size: 15px; font-weight: 700; }
  .studio .st-logo { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 700; }
  .studio .st-transport { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .studio .st-bpm { font-size: 12px; color: var(--st-muted); display: flex; align-items: center; gap: 6px; }
  .studio .st-bpm input {
    width: 68px; min-height: 44px; border-radius: 8px; border: 1px solid var(--st-edge);
    background: var(--st-bg); color: var(--st-text); font: inherit; font-size: 13px; padding: 0 8px;
  }
  .studio .st-pos { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 14px; padding: 0 6px; }
  .studio .st-presence { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-left: auto; }
  .studio .st-chip { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--st-muted); }
  .studio .st-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--st-human); flex: 0 0 auto; }
  .studio .st-dot-agent { background: var(--st-agent); }
  .studio .st-body { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px; padding: 12px; }
  .studio .st-main { flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
  .studio .st-side {
    flex: 1 1 300px; max-width: 100%; display: flex; flex-direction: column; gap: 10px;
    background: var(--st-panel); border: 1px solid var(--st-line); border-radius: 10px; padding: 12px;
  }
  .studio .st-side-head { display: flex; align-items: center; gap: 8px; }
  .studio .st-side-head h2 { margin: 0; font-size: 14px; font-weight: 600; }
  .studio .st-side-note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--st-muted); }
  .studio .st-btn {
    min-height: 44px; min-width: 44px; padding: 0 12px; border-radius: 8px;
    border: 1px solid var(--st-edge); background: #24282D; color: var(--st-text);
    font: inherit; font-size: 13px; cursor: pointer;
  }
  .studio .st-btn:hover:not(:disabled) { border-color: #4A5058; }
  .studio .st-btn:disabled { opacity: 0.5; cursor: default; }
  .studio .st-btn.st-small { min-height: 44px; font-size: 12px; padding: 0 10px; }
  .studio .st-danger { color: var(--st-danger); }
  .studio .st-transport-btn { width: 44px; padding: 0; font-size: 15px; }
  .studio .st-grid-wrap {
    overflow: auto; max-width: 100%; border: 1px solid var(--st-line);
    border-radius: 10px; background: var(--st-panel);
  }
  .studio .st-grid { display: grid; width: max-content; min-width: 100%; }
  .studio .st-corner {
    display: flex; flex-direction: column; gap: 6px; padding: 8px;
    border-right: 1px solid var(--st-line); border-bottom: 1px solid var(--st-line);
    background: var(--st-head);
  }
  .studio .st-th {
    display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 8px;
    border-right: 1px solid var(--st-line); border-bottom: 1px solid var(--st-line);
    background: var(--st-head);
  }
  .studio .st-th-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .studio .st-color { width: 8px; height: 26px; border-radius: 3px; flex: 0 0 auto; }
  .studio .st-th-name { display: flex; flex-direction: column; min-width: 0; }
  .studio .st-name {
    font-size: 13px; font-weight: 600; cursor: pointer;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .studio .st-kind {
    font-size: 11px; color: var(--st-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .studio .st-th-btns { display: flex; gap: 4px; }
  .studio .st-toggle {
    flex: 1 1 0; min-width: 44px; min-height: 44px; border-radius: 6px;
    border: 1px solid var(--st-edge); background: #24282D; color: var(--st-text);
    font: inherit; font-size: 12px; cursor: pointer;
  }
  .studio .st-toggle:disabled { opacity: 0.45; cursor: default; }
  .studio .st-toggle.st-on { background: #3D3420; border-color: #5C4A1E; }
  .studio .st-th-mix { display: flex; flex-direction: column; gap: 4px; }
  .studio .st-range { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--st-muted); }
  .studio .st-range-input { width: 100%; min-height: 44px; accent-color: var(--st-human); }
  .studio .st-select {
    min-height: 44px; width: 100%; border-radius: 8px; border: 1px solid var(--st-edge);
    background: var(--st-bg); color: var(--st-text); font: inherit; font-size: 12px; padding: 0 6px;
  }
  .studio .st-th-manage { display: flex; gap: 4px; }
  .studio .st-audio { display: flex; flex-direction: column; gap: 6px; }
  .studio .st-arm { flex: 0 0 auto; }
  .studio .st-latchip {
    display: inline-flex; align-items: center; min-height: 32px; padding: 0 8px; border-radius: 6px;
    border: 1px solid var(--st-edge); background: #24282D; color: var(--st-muted);
    font: inherit; font-size: 11px; cursor: pointer;
  }
  .studio .st-latchip[data-role=latency] { color: var(--st-text); }
  .studio .st-warn { margin: 0; font-size: 11px; line-height: 1.45; color: var(--st-human); }
  .studio .st-record-btn { color: var(--st-danger); font-size: 18px; }
  .studio .st-rec { font-size: 12px; color: var(--st-human); }
  .studio .st-rec-notice {
    flex: 1 1 100%; font-size: 12px; line-height: 1.45; color: var(--st-human);
  }
  .studio .st-recordings { display: flex; flex-direction: column; gap: 6px; }
  .studio .st-pending {
    border: 1px solid var(--st-line); border-radius: 8px; background: var(--st-head); padding: 8px 10px;
  }
  .studio .st-pending-text { margin: 0; font-size: 12px; line-height: 1.4; color: var(--st-muted); }
  .studio .st-dialog {
    position: fixed; inset: 0; z-index: 1300; display: flex; align-items: center; justify-content: center;
    padding: 16px; background: rgba(0, 0, 0, 0.55); font-family: Inter, system-ui, sans-serif;
  }
  .studio .st-dialog-box {
    max-width: min(520px, 94vw); display: flex; flex-direction: column; gap: 10px;
    padding: 16px; border-radius: 12px; border: 1px solid var(--st-edge); background: var(--st-panel);
    color: var(--st-text); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }
  .studio .st-dialog-title { margin: 0; font-size: 15px; font-weight: 700; }
  .studio .st-dialog-text { margin: 0; font-size: 13px; line-height: 1.5; color: var(--st-muted); }
  .studio .st-dialog-status { margin: 0; font-size: 13px; line-height: 1.5; min-height: 20px; }
  .studio .st-dialog .st-th-btns { gap: 8px; }
  .studio .st-icon {
    flex: 1 1 0; min-width: 44px; min-height: 44px; border-radius: 6px;
    border: 1px solid var(--st-edge); background: #24282D; color: var(--st-text);
    font: inherit; font-size: 14px; cursor: pointer;
    white-space: nowrap; overflow: hidden;
  }
  .studio .st-scene {
    display: flex; align-items: center; gap: 4px; min-width: 0; padding: 4px 6px;
    border-bottom: 1px solid var(--st-line); border-right: 1px solid var(--st-line);
    background: var(--st-panel);
  }
  .studio .st-scene-name {
    flex: 1 1 auto; min-width: 0; font-size: 12px; font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .studio .st-cell { padding: 6px; border-right: 1px solid var(--st-line-soft); border-bottom: 1px solid var(--st-line-soft); }
  .studio .st-clip {
    width: 100%; min-height: 46px; padding: 2px 8px; border-radius: 7px;
    border: 2px solid var(--st-human); background: #24282D; color: var(--st-text);
    font: inherit; font-size: 12px; font-weight: 600; text-align: left; cursor: pointer;
    display: flex; flex-direction: column; justify-content: center; overflow: hidden;
  }
  .studio .st-clip.st-selected { box-shadow: inset 0 0 0 2px #FFFFFF; }
  .studio .st-clip-by { font-size: 10px; font-weight: 500; color: var(--st-muted); }
  .studio .st-empty {
    width: 100%; min-height: 46px; border-radius: 7px; border: 1px dashed #2F343A;
    background: transparent; color: var(--st-muted); font: inherit; font-size: 15px; cursor: pointer;
  }
  .studio .st-empty:hover { border-color: var(--st-human); color: var(--st-text); }
  .studio .st-hint { margin: 0; font-size: 12px; color: var(--st-muted); }
  .studio .st-editor {
    border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-panel);
    display: flex; flex-direction: column; gap: 10px; padding: 10px 12px;
  }
  .studio .st-ed-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
  .studio .st-ed-title { margin: 0; font-size: 14px; font-weight: 600; }
  .studio .st-ed-name {
    min-width: 140px; max-width: 240px; min-height: 44px; border-radius: 8px;
    border: 1px solid var(--st-edge); background: var(--st-bg); color: var(--st-text);
    font: inherit; font-size: 13px; padding: 0 8px;
  }
  .studio .st-ed-meta { font-size: 12px; color: var(--st-muted); }
  .studio .st-ed-field { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--st-muted); }
  .studio .st-ed-field .st-select { width: 96px; }
  .studio .st-roll {
    max-height: 288px; overflow: auto; border-top: 1px solid var(--st-line);
    border-bottom: 1px solid var(--st-line); background: var(--st-bg);
  }
  .studio .st-roll-svg { display: block; touch-action: none; }
  .studio .st-roll-key { fill: #6F767E; font-size: 9px; font-family: ui-monospace, monospace; }
  .studio .st-line { stroke: #2A2F35; stroke-width: 1; }
  .studio .st-line-thin { stroke: #23272C; }
  .studio .st-line-bar { stroke: #3A4048; }
  .studio .st-note { cursor: grab; }
  .studio .st-note-sel { stroke: #FFFFFF; stroke-width: 2; }
  .studio .st-device { display: flex; flex-direction: column; gap: 6px; }
  .studio .st-device-title { margin: 0; font-size: 12px; font-weight: 600; color: var(--st-muted); }
  .studio .st-device-params { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px 12px; }
  .studio .st-param { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--st-muted); }
  .studio .st-param-input { width: 100%; min-height: 44px; accent-color: var(--st-agent); }
  .studio .st-inline {
    min-height: 44px; width: 100%; border-radius: 6px; border: 1px solid var(--st-edge);
    background: var(--st-bg); color: var(--st-text); font: inherit; font-size: 13px; padding: 0 6px;
  }
  .studio .st-history { display: flex; flex-direction: column; gap: 8px; }
  .studio .st-entry {
    border: 1px solid var(--st-line); border-radius: 8px; background: var(--st-head);
    padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
  }
  .studio .st-entry.st-undone { opacity: 0.6; background: #141619; }
  .studio .st-entry-top { display: flex; align-items: center; gap: 6px; }
  .studio .st-entry-who { font-size: 11px; color: var(--st-muted); }
  .studio .st-entry-text { margin: 0; font-size: 13px; line-height: 1.4; }
  .studio .st-conflict { margin: 0; font-size: 11px; color: var(--st-danger); }
  .studio .st-empty-note { margin: 0; font-size: 12px; color: var(--st-muted); }
  .studio .st-notice {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
    margin: 12px; padding: 12px; border: 1px solid var(--st-edge); border-radius: 8px;
    background: var(--st-panel);
  }
  .studio .st-notice-text { margin: 0; font-size: 13px; }
  .studio .st-ask-label { font-size: 12px; color: var(--st-muted); }
  .studio .st-ask { display: flex; gap: 6px; }
  .studio .st-ask input {
    flex: 1 1 auto; min-width: 0; min-height: 44px; border-radius: 8px;
    border: 1px solid var(--st-edge); background: var(--st-bg); color: var(--st-text);
    font: inherit; font-size: 13px; padding: 0 10px;
  }
  .studio .st-ask button {
    min-height: 44px; padding: 0 14px; border-radius: 8px; border: none;
    background: var(--st-agent); color: #0E1A26; font: inherit; font-weight: 600; font-size: 13px;
  }
  .studio .st-ask input:disabled, .studio .st-ask button:disabled { opacity: 0.55; cursor: default; }
  .studio .st-songs { display: flex; flex-direction: column; gap: 8px; }
  .studio .st-song {
    display: flex; flex-direction: column; gap: 2px; padding: 10px 12px;
    border: 1px solid var(--st-line); border-radius: 8px; background: var(--st-panel);
    text-decoration: none; color: var(--st-text); min-height: 44px;
  }
  .studio .st-song:hover { border-color: var(--st-human); }
  .studio .st-song-title { font-size: 14px; font-weight: 600; }
  .studio .st-song-meta { font-size: 11px; color: var(--st-muted); }
  .studio .st-library { display: flex; flex-direction: column; gap: 12px; padding: 12px; }
  .studio .st-new {
    display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px;
    padding: 12px; border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-panel);
  }
  .studio .st-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--st-muted); }
  .studio .st-field input, .studio .st-field select {
    min-height: 44px; border-radius: 8px; border: 1px solid var(--st-edge);
    background: var(--st-bg); color: var(--st-text); font: inherit; font-size: 13px; padding: 0 8px;
  }
  .studio .st-toast {
    position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
    z-index: 1200; max-width: min(520px, 92vw); padding: 10px 14px; border-radius: 10px;
    background: #24282D; color: #E9E6DF; border: 1px solid #3A3F46;
    font-family: Inter, system-ui, sans-serif; font-size: 13px; line-height: 1.4;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  }
  .studio .st-takes { display: flex; flex-direction: column; gap: 8px; }
  .studio .st-takes-hint { margin: 0; font-size: 12px; line-height: 1.45; color: var(--st-muted); }
  .studio .st-comp {
    position: relative; height: 34px; border-radius: 8px; border: 1px solid var(--st-line);
    background: var(--st-bg); overflow: hidden; touch-action: none; cursor: crosshair;
  }
  .studio .st-comp-line {
    position: absolute; top: 0; bottom: 0; width: 1px; background: var(--st-line-soft);
  }
  .studio .st-comp-seg {
    position: absolute; top: 3px; bottom: 3px; border-radius: 5px; overflow: hidden;
    display: flex; align-items: center; justify-content: flex-start; padding: 0 6px;
    font-size: 11px; font-weight: 600; color: #17191C; white-space: nowrap;
  }
  .studio .st-comp-pick {
    position: absolute; top: 0; bottom: 0; background: rgba(242, 165, 65, 0.35);
    border-left: 2px solid var(--st-human); border-right: 2px solid var(--st-human);
    pointer-events: none;
  }
  .studio .st-take-list { display: flex; flex-direction: column; gap: 6px; }
  .studio .st-take {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px;
    border: 1px solid var(--st-line); border-radius: 8px; background: var(--st-head);
    color: var(--st-text); font: inherit; cursor: pointer;
  }
  .studio .st-take.st-take-sel { border-color: var(--st-human); box-shadow: inset 0 0 0 1px var(--st-human); }
  .studio .st-take.st-take-off { opacity: 0.5; }
  .studio .st-take-color { width: 8px; align-self: stretch; min-height: 28px; border-radius: 3px; flex: 0 0 auto; }
  .studio .st-take-main { display: flex; flex-direction: column; min-width: 0; flex: 1 1 120px; }
  .studio .st-take-name { font-size: 13px; font-weight: 600; }
  .studio .st-take-meta { font-size: 11px; color: var(--st-muted); }
  .studio .st-take-badge {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 2px 6px; border-radius: 6px; border: 1px solid #5C4A1E; background: #3D3420;
    color: var(--st-human);
  }
  .studio .st-take-acts { display: flex; flex-wrap: wrap; gap: 4px; margin-left: auto; }
  .studio .st-takes-foot { display: flex; flex-wrap: wrap; gap: 8px; }
  @media (max-width: 640px) {
    .studio .st-body { padding: 8px; gap: 8px; }
    .studio .st-pos { font-size: 13px; }
  }
`;

/**
 * The "New song" form's project picker: every live project space, newest name
 * order, with archived and deleted rows left out.
 * @param {object} db - the dashboard's database client
 * @returns {Promise<Array<{id: number, name: string}>>}
 */
async function listProjects(db) {
  try {
    const { rows } = await db.execute({
      sql: `SELECT id, name FROM project_spaces
             WHERE archived_at IS NULL AND (status IS NULL OR status != 'archived')
             ORDER BY name COLLATE NOCASE`,
      args: [],
    });
    return (rows ?? []).map((row) => ({ id: Number(row.id), name: String(row.name ?? "") }));
  } catch (err) {
    console.warn("[studio] project list failed:", err?.message ?? err);
    return [];
  }
}

/** The dashboard layout, or a bare page when the panel is rendered on its own. */
function renderer(layout) {
  if (typeof layout === "function") return layout;
  return ({ title, content }) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${content}</body></html>`;
}

/** The song library page. */
async function libraryPage({ db, render, res }) {
  const projects = await listProjects(db);
  const options = projects
    .map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`)
    .join("");

  const content = `
    <style>${STYLES}</style>
    <div class="studio" data-studio-library="1">
      <header class="st-bar">
        <span class="st-logo">Crow Studio</span>
        <span class="st-title" style="font-weight:400;color:var(--st-muted)">one live song, you and an agent</span>
      </header>
      <div class="st-library">
        <label class="st-field" style="max-width:280px">
          Show songs from
          <select data-role="project-filter">
            <option value="">All projects</option>
            ${options}
          </select>
        </label>
        <div class="st-songs" data-role="songs">
          <p class="st-empty-note">Loading songs…</p>
        </div>
        <form class="st-new" data-act="new-song">
          <label class="st-field">
            Title
            <input name="title" type="text" maxlength="80" placeholder="A new song" required>
          </label>
          <label class="st-field">
            Project
            <select name="project_id" required>
              ${
                projects.length
                  ? options
                  : '<option value="">No projects yet</option>'
              }
            </select>
          </label>
          <button class="st-btn" type="submit">New song</button>
        </form>
      </div>
      <div class="st-toast" data-role="toast" hidden></div>
      <script>${TAKE_STORE_SCRIPT}
${CLIENT_SCRIPT}</script>
    </div>`;

  res.send(render({ title: "Studio", content }));
}

/** One song's studio page. */
function studioPage({ songId, render, res }) {
  const id = escapeHtml(songId);
  const content = `
    <style>${STYLES}</style>
    <div class="studio" data-studio-song="${id}">
      <header class="st-bar">
        <a class="st-back" href="/dashboard/studio">← Songs</a>
        <span class="st-title" data-role="title">Song</span>
        <div class="st-transport">
          <button class="st-btn st-transport-btn" type="button" data-act="play" title="Play" aria-label="Play">▶</button>
          <button class="st-btn st-transport-btn" type="button" data-act="stop" title="Stop" aria-label="Stop">■</button>
          <button class="st-btn st-transport-btn st-record-btn" type="button" data-act="record" title="Record into the armed track" aria-label="Record" disabled>●</button>
          <span class="st-rec" data-role="rec-status" hidden></span>
          <label class="st-bpm">bpm
            <input data-role="bpm" type="number" min="20" max="300" step="1" value="120" aria-label="Tempo in beats per minute">
          </label>
          <span class="st-pos" data-role="position">001.1.1</span>
        </div>
        <span class="st-rec-notice" data-role="rec-notice" hidden></span>
        <div class="st-presence" data-role="presence"></div>
      </header>
      <div class="st-body">
        <main class="st-main">
          <div class="st-grid-wrap" data-role="grid-wrap">
            <div class="st-grid" data-role="grid"></div>
          </div>
          <p class="st-hint" data-role="hint">Add a track and a scene to start.</p>
          <section class="st-recordings" data-role="recordings" hidden></section>
          <section class="st-editor" data-role="editor" hidden></section>
        </main>
        <aside class="st-side">
          <div class="st-side-head">
            <span class="st-dot st-dot-agent"></span>
            <h2>Agent activity &amp; history</h2>
          </div>
          <p class="st-side-note">Every change, yours or the agent's, is one step here. Undo any step; the agent never edits a locked track or the clip you have open.</p>
          <div class="st-history" data-role="history"></div>
          <label class="st-ask-label" for="st-ask">Ask the agent</label>
          <div class="st-ask">
            <input id="st-ask" type="text" placeholder="Connect a project bot to ask" aria-label="Ask the agent" disabled>
            <button type="button" disabled>Send</button>
          </div>
        </aside>
      </div>
      <div class="st-toast" data-role="toast" hidden></div>
      <script type="importmap">{"imports":{"lib0/":"/dashboard/studio/assets/lib0/"}}</script>
      <!-- The resampler is a page-level global (StudioResample): the engine
           client converts a take recorded at another rate with it, and so does
           its worker. -->
      <script>${TAKE_STORE_SCRIPT}
${CLIENT_SCRIPT}</script>
      <script src="/dashboard/studio/assets/resample.js"></script>
    </div>`;

  res.send(render({ title: "Studio", content }));
}

export default {
  id: "studio",
  name: "Studio",
  icon: "music",
  route: "/dashboard/studio",
  navOrder: 45,
  category: "media",

  /**
   * GET /dashboard/studio[?song=<id>]
   * @param {object} req - Express request (`query.song`)
   * @param {object} res - Express response
   * @param {{db: object, layout?: Function}} context
   */
  async handler(req, res, { db, layout } = {}) {
    const render = renderer(layout);
    const songId = typeof req?.query?.song === "string" ? req.query.song.trim() : "";
    if (songId) return studioPage({ songId, render, res });
    return libraryPage({ db, render, res });
  },
};