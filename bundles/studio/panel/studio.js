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
 *     history and the presence row, and — plan 1d's Task 10 — the mixer screen,
 *     which carries one strip per track, then the returns, then the master.
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

import { existsSync, readFileSync } from "node:fs";
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

// The effect and amp tables come from the bundle's own server/doc.js BY PATH,
// like the client: an installed copy lives at <crow-home>/panels/studio.js,
// where a relative "../server/doc.js" would point at a file that is not there.
const { EFFECT_KINDS, EFFECT_PARAMS, AMP_PARAMS } = await import(
  pathToFileURL(join(findBundleDir(), "server", "doc.js")).href
);

/**
 * The mixer's one effect table, handed to the page as `window.StudioMixer`.
 *
 * The effects a chain holds and each parameter's range live in exactly one
 * place (`server/doc.js`: `EFFECT_PARAMS`), which the server checks every
 * `insert.set` against. The amp is the one insert kind whose sound is a file the
 * operator chose, so it travels beside the effects as `amp` (its own table,
 * `AMP_PARAMS`, plus the kind's id) — the "+ effect" menu offers it and its
 * editor draws its three numbers from the same table. `bundled` is the starter
 * sounds this bundle ships, which the amp editor's pickers offer beside the
 * song's own captures and cabinets. All of it travels as its own classic script,
 * the way the controllers' routing rule does, because the client is emitted as
 * one string and cannot import a module at runtime.
 * @type {string}
 */
export const MIXER_EFFECTS_SCRIPT =
  "(function(){window.StudioMixer = " +
  mixerEffectsJson() +
  ";})();";

/**
 * The effect table as a JSON literal that is safe inside a classic script tag.
 *
 * `<` travels as `\u003c` and the two JavaScript line terminators (U+2028 and
 * U+2029) as their escapes, so no label an effect table ever grows can close the
 * element or break the statement it sits in. JSON.parse reads both back to the
 * same character, so the page sees the table the server checks against.
 * @returns {string}
 */
function mixerEffectsJson() {
  return JSON.stringify({
    kinds: EFFECT_KINDS,
    params: EFFECT_PARAMS,
    amp: { kind: "amp", label: AMP_PARAMS.amp.label, params: AMP_PARAMS.amp.params },
    bundled: findBundled(),
  })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The starter sounds this bundle ships, as the amp editor's pickers offer them.
 *
 * Read once from the bundle the page is served out of (`library/bundled.json`),
 * and narrowed to what a picker and a credit line need: the id, the kind, the
 * name, the licence and the credit. The size and hash stay on the server, where
 * the file route and a render check them. A bundle without the list carries no
 * starters, and the pickers simply offer the song's own sounds.
 * @returns {Array<{id: string, kind: string, name: string, licence: string, credit: string}>}
 */
function findBundled() {
  const dir = findBundleDir();
  if (!dir) return [];
  try {
    const list = JSON.parse(readFileSync(join(dir, "library", "bundled.json"), "utf8"));
    const entries = Array.isArray(list?.entries) ? list.entries : [];
    return entries
      .filter((row) => row && typeof row.id === "string" && (row.kind === "nam" || row.kind === "ir"))
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        name: typeof row.name === "string" ? row.name : row.id,
        licence: typeof row.licence === "string" ? row.licence : "",
        credit: typeof row.credit === "string" ? row.credit : "",
      }));
  } catch {
    return [];
  }
}

/**
 * The catalog's default entry: the one row `library/catalog.json` marks
 * `default: true`, which is what "Get the default instruments" downloads. Read
 * once, from the bundle the page is served out of; a bundle with no catalog
 * (or a page rendered on its own) leaves it empty, and the panel's action says
 * so instead of guessing an id.
 * @returns {string}
 */
function findCatalogDefault() {
  const dir = findBundleDir();
  if (!dir) return "";
  try {
    const catalog = JSON.parse(readFileSync(join(dir, "library", "catalog.json"), "utf8"));
    const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
    const entry = entries.find((row) => row && row.default === true);
    return entry && typeof entry.id === "string" ? entry.id : "";
  } catch {
    return "";
  }
}

/** The catalog entry the default-instruments action downloads, or "". */
const CATALOG_DEFAULT = findCatalogDefault();

/**
 * The local-first take store, loaded once: it must reach the page BEFORE the
 * client, because the client asks `window.StudioTakeStore` for the takes this
 * device kept.
 */
const TAKE_STORE_SCRIPT = await loadPanelScript("take-store.js", "TAKE_STORE_SCRIPT");

/**
 * Web MIDI access, loaded once: like the take store it reaches the page BEFORE
 * the client, which asks `window.StudioMidi` for the devices and for the
 * messages a controller sends. It is the only thing that ever calls
 * `navigator.requestMIDIAccess`, and only from the Connect controllers button.
 */
const MIDI_SCRIPT = await loadPanelScript("midi.js", "MIDI_SCRIPT");

/**
 * The routing rule, loaded once: the SAME text `server/commands/midi.js`
 * evaluates in Node, so the hub and the page can never answer a message
 * differently. It comes before the client, which routes through
 * `window.StudioMidiRoute.routeFor`.
 */
const MIDI_ROUTE_SCRIPT = await loadPanelScript("midi-route.js", "MIDI_ROUTE_SCRIPT");

/**
 * The pad input rules, loaded once: press velocity and the chromatic / 16
 * velocity pitches, the SAME pure functions the pad grid, the 16 velocity mode
 * and the on-screen keyboard all read. They reach the page before the client,
 * which asks `window.StudioPadInput` for them; a page served without the script
 * plays its pads plainly instead of failing (see panel/pad-input.js).
 */
const PAD_INPUT_SCRIPT = await loadPanelScript("pad-input.js", "PAD_INPUT_SCRIPT");

/**
 * The record view's rules, loaded once: the level floor and the meter fill, the
 * peak hold, the live waveform's draw ring and the words a lane uses for where
 * it listens and what it hears. They reach the page before the client, which
 * draws the record lanes with them; a page served without the script draws its
 * lanes without those labels instead of failing (see panel/record-view.js).
 */
const RECORD_VIEW_SCRIPT = await loadPanelScript("record-view.js", "RECORD_VIEW_SCRIPT");

/**
 * The punch rules, loaded once: the comp splice and its comparison, the range
 * that fits a clip, and the frames one pass's gate opens and closes on. It is
 * the SAME text `panel/punch.js` evaluates in Node, so a page and a test can
 * never disagree about a punch. It comes before the client, which asks
 * `window.StudioPunch` for those rules (see panel/punch.js).
 */
const PUNCH_SCRIPT = await loadPanelScript("punch.js", "PUNCH_SCRIPT");

/**
 * The shell's layout model, loaded once: which widget is on the page, in what
 * order and at which size is this device's own view state, and the model that
 * decides it comes BEFORE the shell that reads it and before the client, which
 * hands a song the operator's template through `seedSong` at boot.
 */
const SHELL_LAYOUT_SCRIPT = await loadPanelScript("shell-layout.js", "SHELL_LAYOUT_SCRIPT");

/**
 * The shell: the top bar, the three modes, the Layout menu, the widget frames
 * and the tray. It MOVES the nodes this page already renders, so it reaches the
 * page before the client, which keeps finding the same elements.
 */
const SHELL_SCRIPT = await loadPanelScript("shell.js", "SHELL_SCRIPT");

/** The shell's styles, which land after this page's own rules. */
const SHELL_CSS = await loadPanelScript("shell.js", "SHELL_CSS");

/**
 * The transport bar: play, stop, pause, record, the bpm, the position, the
 * recording status, the click and the output picker, in one bar that ends on
 * the player bar. Like the shell it takes over the page's own controls.
 */
const TRANSPORT_SCRIPT = await loadPanelScript("transport-bar.js", "TRANSPORT_SCRIPT");

/** The transport bar's styles: the page's bottom padding and the toast's rise. */
const TRANSPORT_CSS = await loadPanelScript("transport-bar.js", "TRANSPORT_CSS");

/**
 * The head tag that makes Turbo do a full load of this page.
 *
 * The gateway adds `'wasm-unsafe-eval'` to the Content-Security-Policy only for
 * responses under `/dashboard/studio` (the audio worklet compiles the SunVox
 * WASM engine). Turbo Drive keeps the FIRST page's policy for the document it
 * navigates in place, so a Studio reached from another dashboard page would
 * have no wasm and no audio. A full load is the fix: the response's own CSP is
 * then the one the page runs under. A panel cannot write the document head, but
 * the dashboard layout renders an extra-head option, and that is this.
 */
const TURBO_RELOAD_HEAD = '<meta name="turbo-visit-control" content="reload">';

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
 *
 * The shell's and the transport bar's own rules come after these (they adjust
 * the toast and the page's bottom padding, and the last rule for a selector is
 * the one that counts), so the page is one style block.
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
  /* The top bar, the widget frames and the transport bar are the shell's own
     (panel/shell.js and panel/transport-bar.js carry their styles). What the
     page keeps under that bar is the strip of timeline tools, the notices a
     render can set, and the transport controls before the bar takes them. */
  /* The library page's own header. The song page has no .st-bar any more: its
     top bar is the shell's, and the header the handler renders is the row the
     shell moves those four controls out of. */
  .studio .st-bar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px;
    padding: 10px 14px; background: var(--st-head); border-bottom: 1px solid var(--st-line);
  }
  .studio .st-chrome { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; padding: 10px 14px; }
  .studio .st-strips { display: flex; flex-direction: column; gap: 8px; }
  /* A strip the page is not using takes no room, whatever it draws with. */
  .studio .st-strips > [hidden] { display: none; }
  .studio .st-strips .st-tl-tools { padding: 8px 12px 0; }
  .studio .st-strips .st-midi-bar { padding: 0 12px; }
  .studio .st-strips .st-notices {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 12px;
  }
  .studio .st-strips .st-notices > [hidden] { display: none; }
  .studio .st-back { font-size: 13px; text-decoration: none; color: var(--st-muted); }
  .studio .st-title { font-size: 15px; font-weight: 700; }
  .studio .st-logo { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 700; }
  .studio .st-transport { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  /* The click toggle and the output picker are this browser's own settings, so
     they sit beside the transport rather than in any of the song's own panels. */
  .studio .st-click-btn[aria-pressed=true] { background: #3A2F1C; border-color: var(--st-human); color: var(--st-human); }
  .studio .st-out-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .studio .st-out-bar[hidden] { display: none; }
  .studio .st-out-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--st-muted); }
  .studio .st-out-bar .st-select { width: auto; min-width: 150px; }
  .studio .st-output-note { font-size: 12px; line-height: 1.4; color: var(--st-human); }
  .studio .st-output-note:empty { display: none; }
  .studio .st-bpm { font-size: 12px; color: var(--st-muted); display: flex; align-items: center; gap: 6px; }
  .studio .st-bpm input {
    width: 68px; min-height: 44px; border-radius: 8px; border: 1px solid var(--st-edge);
    background: var(--st-bg); color: var(--st-text); font: inherit; font-size: 13px; padding: 0 8px;
  }
  .studio .st-pos { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 14px; padding: 0 6px; }
  .studio .st-latency { font-size: 11px; color: var(--st-muted); }
  .studio .st-latency[hidden] { display: none; }
  /* A press-and-hold on a control is a press, not a text selection. On Android
     the hold selected the button's label and opened the Copy/Share menu instead
     of moving the pad it was held on (the Looper), so every control of the page
     is listed here once. Nothing that is TEXT is in this list: an input, a
     textarea, a select's own text, and the ask box with its messages all stay
     selectable. */
  .studio button,
  .studio [role=button],
  .studio .st-btn,
  .studio .st-transport-btn,
  .studio .st-mode,
  .studio .st-toggle,
  .studio .st-pad,
  .studio .st-step,
  .studio .st-fx-btn,
  .studio .st-empty,
  .studio .st-cell,
  .studio .st-clip,
  .studio .st-tl-block,
  .studio .st-roll-svg,
  .studio rect.st-note {
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  /* A field inside one of those controls is still a field: the hold above must
     not reach into it, or text the operator has to edit (a velocity, a clip's
     name, a block's label) could not be selected or long-pressed at all. This
     rule comes after the one above and names every such field, both bare and
     inside the containers that hold them. */
  .studio input,
  .studio textarea,
  .studio [contenteditable],
  .studio .st-cell input,
  .studio .st-cell textarea,
  .studio .st-cell [contenteditable],
  .studio .st-clip input,
  .studio .st-clip textarea,
  .studio .st-clip [contenteditable],
  .studio .st-tl-block input,
  .studio .st-tl-block textarea,
  .studio .st-tl-block [contenteditable],
  .studio [role=button] input,
  .studio [role=button] textarea,
  .studio [role=button] [contenteditable],
  .studio button input,
  .studio button textarea,
  .studio button [contenteditable] {
    user-select: text; -webkit-user-select: text; -webkit-touch-callout: default;
  }
  /* Touch targets (G11): the controls a finger plays are at least 44 px in both
     directions — a pad, a step, a bank tab and a performance effect. This is the
     FLOOR, not the size: a control's own rule below may make it bigger (a pad is
     72 px square), so it comes before those rules and never after them. */
  .studio .st-pad,
  .studio .st-step,
  .studio .st-bank-tabs .st-toggle,
  .studio .st-fx-btn {
    min-width: 44px; min-height: 44px;
  }
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
  /* The track's name is a real button — a tap, or Enter and Space, selects the
     track and opens its editor — drawn as plain text: no chrome, one line, and
     an ellipsis when the name is long. It is a BLOCK box on purpose, because
     text-overflow needs one; a flex box here clipped a long name with no
     ellipsis. Its height is the name's own line, so the header keeps the pitch
     it had before the name became a control, and the 44 px target is the pencil
     beside it, in the same row. */
  .studio .st-name {
    display: block; min-width: 44px; padding: 0; margin: 0;
    border: 0; background: none; color: inherit; font: inherit;
    font-size: 13px; font-weight: 600; text-align: left; cursor: pointer;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  /* The pencil beside a track's name is its own 44 px target: renaming and
     selecting the track are two different things, so they never share one tap. */
  .studio .st-track-rename {
    flex: 0 0 auto; min-width: 44px; min-height: 44px; border-radius: 6px;
    border: 1px solid var(--st-edge); background: #24282D; color: var(--st-text);
    font: inherit; font-size: 14px; cursor: pointer;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  /* The track the operator selected by tapping its name (aimTrackId). It is this
     page's view state: the song does not know which track is aimed at. */
  .studio .st-th-aimed { box-shadow: inset 0 0 0 2px var(--st-human); }
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
  /* The controllers (mockup screen 4, the part the router and Learn need): the
     two header buttons, and in the body the devices, the Learn line and one row
     per mapping — the device and its message, what it does, and who set it. A
     row lights for a moment when its own message arrives. */
  .studio .st-midi-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .studio .st-midi-state { font-size: 12px; line-height: 1.4; color: var(--st-muted); }
  .studio .st-midi-state:empty { display: none; }
  .studio .st-midi {
    border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-panel);
    display: flex; flex-direction: column; gap: 8px; padding: 10px 12px;
  }
  .studio .st-midi:empty { display: none; }
  .studio .st-midi-title { margin: 0; font-size: 14px; font-weight: 600; }
  .studio .st-midi-note { margin: 0; font-size: 12px; line-height: 1.45; color: var(--st-muted); }
  .studio .st-midi-notice { margin: 0; font-size: 12px; line-height: 1.45; color: var(--st-human); }
  .studio .st-midi-target { margin: 0; font-size: 12px; line-height: 1.45; color: var(--st-text); }
  .studio .st-midi-devices { display: flex; flex-wrap: wrap; gap: 6px; }
  .studio .st-midi-device {
    display: flex; align-items: center; gap: 8px; padding: 6px 10px;
    border: 1px solid var(--st-edge); border-radius: 8px; background: var(--st-head);
    font-size: 12px;
  }
  .studio .st-midi-device-name { font-weight: 600; }
  .studio .st-midi-device-state { color: var(--st-muted); font-size: 11px; }
  .studio .st-midi-list { display: flex; flex-direction: column; gap: 4px; }
  .studio .st-midi-row {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px;
    padding: 6px 10px; border: 1px solid var(--st-line); border-radius: 8px;
    background: var(--st-head); font-size: 12px;
  }
  .studio .st-midi-hit { border-color: var(--st-human); background: #2A2418; }
  .studio .st-midi-row .st-midi-device-name { min-width: 96px; }
  .studio .st-midi-msg { color: var(--st-muted); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px; }
  .studio .st-midi-does { flex: 1 1 160px; }
  .studio .st-midi-by { color: var(--st-muted); font-size: 11px; margin-left: auto; }
  /* The MIDI page's own parts (mockup screen 4): a card per controller, the
     Set up for menu, the notice above the bot's proposals, and the table —
     Control, Sends, Does, Set by, and one pair of buttons per row. The table
     scrolls sideways inside its own box, so the page never does. */
  .studio .st-midi-card-top { display: flex; align-items: center; gap: 8px; }
  .studio .st-midi-device { flex-direction: column; align-items: flex-start; gap: 2px; }
  .studio .st-midi-dot-on { background: #6BBF8A; }
  .studio .st-midi-dot-off { background: #5C6167; }
  .studio .st-midi-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
  .studio .st-midi-setup { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--st-muted); }
  .studio .st-midi-setup .st-select { width: auto; min-width: 140px; }
  .studio .st-midi-proposals {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px;
    border: 1px solid #2E4D6B; background: #17222D; border-radius: 10px; padding: 10px 12px;
  }
  .studio .st-midi-proposal-text { flex: 1 1 320px; font-size: 13px; line-height: 1.45; }
  .studio .st-midi-table-wrap {
    overflow-x: auto; border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-head);
  }
  .studio .st-midi-table { width: 100%; min-width: 720px; border-collapse: collapse; font-size: 13px; }
  .studio .st-midi-th {
    padding: 8px 12px; border-bottom: 1px solid var(--st-line); text-align: left;
    font-size: 12px; font-weight: 600; color: var(--st-muted);
  }
  .studio .st-midi-table td { padding: 8px 12px; border-bottom: 1px solid var(--st-line-soft); }
  .studio .st-midi-table tr:last-child td { border-bottom: 0; }
  .studio .st-midi-control { font-weight: 600; }
  .studio .st-midi-table .st-midi-msg { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; color: #C9C5BC; }
  .studio .st-midi-table .st-midi-by { margin-left: 0; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
  .studio .st-midi-row[data-proposed=true] { background: #17222D; }
  .studio .st-midi-acts { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
  .studio .st-midi-acts .st-btn { min-height: 40px; }
  /* In the table a row is a table row and its cells are cells: the list row's
     flex box (above) must not reach them, or the header and the rows part. */
  .studio tr.st-midi-row {
    display: table-row; padding: 0; border: 0; border-radius: 0;
    background: transparent; font-size: 13px;
  }
  .studio tr.st-midi-row[data-proposed=true] { background: #17222D; }
  .studio tr.st-midi-row.st-midi-hit { background: #2A2418; }
  .studio td.st-midi-does { flex: none; }
  .studio td.st-midi-acts { display: table-cell; text-align: right; white-space: nowrap; }
  .studio td.st-midi-acts .st-btn { margin-left: 6px; }
  .studio .st-fx {
    border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-head);
    padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
  }
  .studio .st-fx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
  .studio .st-fx-btn {
    min-height: 52px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--st-edge);
    background: #24282D; color: var(--st-text); font: inherit; font-size: 13px; font-weight: 600;
    cursor: pointer; touch-action: none;
  }
  .studio .st-fx-btn:hover { border-color: #4A5058; }
  .studio .st-fx-btn.st-on { background: var(--st-agent); border-color: var(--st-agent); color: #0E1A26; }
  .studio .st-fx-capture { font-weight: 500; }
  /* The on-screen keyboard: the aimed note track's two octaves, with the octave
     shift beside them. Every key is a 44 px target, a press on one is never a
     text selection or a browser callout, and the strip scrolls sideways on a
     phone so two octaves keep their size. A key the engine reports sounding
     wears one class and no new node. */
  .studio .st-keyboard { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .studio .st-keyboard-head {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px;
  }
  .studio .st-keyboard-title { margin: 0; font-size: 14px; font-weight: 600; }
  .studio .st-keyboard-octave {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 12px; color: var(--st-muted);
  }
  .studio .st-keyboard-shift {
    min-width: 44px; min-height: 44px; padding: 0 10px;
    border: 1px solid var(--st-edge); border-radius: 8px;
    background: #24282D; color: var(--st-text); font: inherit; font-size: 16px;
    cursor: pointer;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  .studio .st-keyboard-scroll {
    min-width: 0; max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch;
  }
  .studio .st-keyboard-keys {
    display: flex; gap: 2px; min-width: max-content; padding: 0 0 4px;
  }
  .studio .st-keyboard-octave-box {
    position: relative; display: flex; flex: 0 0 auto;
    width: calc(7 * 64px); height: 124px;
  }
  .studio .st-key {
    border: 1px solid #121417; font: inherit; cursor: pointer;
    touch-action: none;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  .studio .st-key-white {
    flex: 1 1 0; min-width: 44px; height: 120px; padding: 0 0 6px;
    display: flex; align-items: flex-end; justify-content: center;
    background: #E9E6DF; color: #1B1E22; font-size: 10px;
    border-radius: 0 0 6px 6px;
  }
  .studio .st-key-black {
    position: absolute; top: 0; z-index: 1;
    width: 44px; min-width: 44px; height: 74px; padding: 0 0 4px;
    display: flex; align-items: flex-end; justify-content: center;
    background: #1B1E22; color: #E9E6DF; font-size: 9px;
    border-radius: 0 0 4px 4px;
  }
  .studio .st-key-at-1 { left: calc(14.2857% - 22px); }
  .studio .st-key-at-2 { left: calc(28.5714% - 22px); }
  .studio .st-key-at-4 { left: calc(57.1428% - 22px); }
  .studio .st-key-at-5 { left: calc(71.4285% - 22px); }
  .studio .st-key-at-6 { left: calc(85.7142% - 22px); }
  .studio .st-key.st-key-on { background: var(--st-accent, #E8A33D); color: #1B1E22; border-color: #FFFFFF; }
  /* The control Learn is waiting on: outlined until its message arrives. */
  .studio .st-learn { outline: 2px solid var(--st-human); outline-offset: 2px; }
  .studio .st-midi-bar .st-btn { min-height: 40px; }
  /* A performance the timeline refused: the server's sentence and the two
     buttons that settle it, above the lanes and never hidden by a render. */
  .studio .st-perf-notice {
    flex: 1 1 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
    border: 1px solid var(--st-edge); border-radius: 8px; background: var(--st-head);
    padding: 8px 10px;
  }
  .studio .st-perf-notice[hidden] { display: none; }
  .studio .st-perf-notice .st-perf-text {
    margin: 0; flex: 1 1 260px; font-size: 12px; line-height: 1.45; color: var(--st-human);
  }
  .studio .st-perf-notice .st-th-btns { display: flex; gap: 6px; flex-wrap: wrap; }
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
  /* In Perform the scene's name is its launch control, and a real button: it
     drops the button chrome and keeps the name's own look and its place in the
     header. The 44 px target costs no height here, because the three icons
     beside it already hold the row at that size. */
  .studio button.st-scene-name {
    min-height: 44px; padding: 0 6px; border: 0; background: none; color: inherit;
    font: inherit; font-size: 12px; font-weight: 600; text-align: left; cursor: pointer;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  .studio .st-cell { padding: 6px; border-right: 1px solid var(--st-line-soft); border-bottom: 1px solid var(--st-line-soft); }
  /* What one grid cell is doing, all of it view state and none of it a document
     change: the clip the engine reported playing on its track (green), the scene
     a launch queued for the next bar (orange, dashed), a muted track's cells,
     an empty cell, and the cell of the clip this page has open. */
  .studio .st-cell-playing { background: #16211B; }
  .studio .st-cell-playing .st-clip { border-color: #6FCF97; background: #1F3A2A; }
  .studio .st-cell-next { outline: 2px dashed var(--st-human); outline-offset: -3px; }
  .studio .st-cell-muted { opacity: 0.5; }
  .studio .st-cell-empty { background: #191C20; }
  .studio .st-cell-editing { box-shadow: inset 0 0 0 2px #FFFFFF; }
  /* The editor header's Copy to scene picker: a scene's own name, so it is wider
     than the small numeric fields beside it. */
  .studio .st-copy-scene-field .st-select { width: auto; min-width: 132px; }
  .studio .st-copy-scene-field .st-select:disabled { opacity: 0.55; cursor: default; }
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
  /* The agent's host: the Ask label and its box, side by side inside one
     wrapper the shell wraps in the agent widget. Nothing else goes between
     them: the client puts the transcript beside the box. */
  .studio [data-role=ask] { display: flex; flex-direction: column; gap: 6px; padding: 12px; }
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
  /* What the ask box draws under itself: the operator's own line, the bot's
     server-rendered reply, the working line, and the note that says why the box
     cannot be used. */
  .studio .st-ask-line { margin: 6px 0 0; }
  .studio .st-ask-you {
    border-left: 3px solid var(--st-human); padding-left: 8px; color: var(--st-text);
  }
  .studio .st-ask-reply { overflow-x: auto; }
  .studio .st-ask-reply p { margin: 6px 0; }
  .studio .st-ask-reply a { color: var(--st-agent); }
  .studio .st-ask-reply ul, .studio .st-ask-reply ol { margin: 6px 0; padding-left: 18px; }
  .studio .st-ask-reply .table-scroll { overflow-x: auto; max-width: 100%; }
  .studio .st-ask-reply table {
    border-collapse: collapse; font-size: 11px; margin: 6px 0; max-width: 100%;
  }
  .studio .st-ask-reply th, .studio .st-ask-reply td {
    border: 1px solid var(--st-line); padding: 2px 6px; text-align: left;
  }
  .studio .st-ask-error { color: var(--st-danger); }
  .studio .st-ask-working { margin: 6px 0 0; color: var(--st-muted); font-style: italic; }
  .studio .st-ask-note { margin: 8px 0 0; font-size: 12px; color: var(--st-muted); }
  .studio .st-ask-note a { color: var(--st-agent); }
  .studio .st-ask-note button {
    margin-left: 6px; min-height: 32px; padding: 0 10px; border-radius: 6px; border: none;
    background: var(--st-agent); color: #0E1A26; font: inherit; font-weight: 600; font-size: 12px;
  }
  .studio .st-ask-note button:disabled { opacity: 0.55; cursor: default; }
  /* One of this song's renders, offered where the bot linked it: built from the
     song id and the validated name, never from the address the bot pasted. */
  .studio .st-ask-render {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
    margin: 6px 0; padding: 6px; border: 1px solid var(--st-edge); border-radius: 8px;
    background: var(--st-panel);
  }
  .studio .st-ask-render audio { max-width: 100%; height: 32px; }
  .studio .st-ask-download { color: var(--st-agent); font-size: 12px; }
  .studio .st-ask-loudbox { flex: 1 1 100%; }
  .studio .st-ask-loud { border-collapse: collapse; font-size: 11px; width: 100%; }
  .studio .st-ask-loud th, .studio .st-ask-loud td {
    border: 1px solid var(--st-line); padding: 2px 6px; text-align: left;
  }
  .studio .st-ask-loud th { color: var(--st-muted); font-weight: 500; }
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
  /* The takes lane and its rows: a press on one is a press, never a text
     selection or the browser's Copy/Share menu. The keep, discard and play
     buttons are 44 px targets, and so is a lane's own header. */
  .studio .st-takes,
  .studio .st-take {
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  .studio .st-take-acts .st-btn { min-width: 44px; min-height: 44px; }
  .studio .st-modes { display: flex; border: 1px solid var(--st-edge); border-radius: 8px; overflow: hidden; }
  .studio .st-mode {
    min-height: 44px; padding: 0 14px; border: none; background: #24282D; color: var(--st-text);
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .studio .st-mode + .st-mode { border-left: 1px solid var(--st-edge); }
  .studio .st-mode[aria-pressed=true] { background: #2E3A2F; }
  .studio .st-tl-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  /* The timeline's own scale: two 44 px buttons and the step it is on. Zoom is
     visual, so these change the width of the lanes and nothing about the song. */
  .studio .st-zoom {
    min-width: 44px; min-height: 44px; padding: 0 10px;
    font-size: 16px; font-weight: 700; line-height: 1;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  .studio .st-zoom-read {
    min-width: 44px; text-align: center;
    font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; color: var(--st-muted);
  }
  .studio .st-tl-rec { display: flex; align-items: center; gap: 8px; }
  .studio .st-tl-rec[aria-pressed=true] { background: #3A1F1C; border-color: var(--st-danger); }
  .studio .st-tl-rec-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--st-danger); flex: 0 0 auto; }
  .studio .st-legend { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--st-muted); }
  .studio .st-tl-notice {
    flex: 1 1 100%; margin: 0; padding: 10px 14px; border-radius: 8px;
    border: 1px solid #5A2A26; background: #2A1A18; font-size: 13px; line-height: 1.45; color: #F2C9C3;
  }
  .studio .st-timeline {
    overflow-x: auto; border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-panel);
  }
  .studio .st-tl { min-width: 1180px; position: relative; }
  .studio .st-tl-row { display: grid; grid-template-columns: 180px minmax(0, 1fr); border-bottom: 1px solid var(--st-line-soft); }
  .studio .st-tl-side {
    padding: 8px 10px; background: var(--st-head); border-right: 1px solid var(--st-line);
    font-size: 11px; line-height: 1.5; color: var(--st-muted);
  }
  .studio .st-tl-ruler .st-tl-side { border-bottom: 1px solid var(--st-line); }
  .studio .st-tl-ruler-body { position: relative; height: 64px; background: var(--st-head); border-bottom: 1px solid var(--st-line); }
  .studio .st-tl-sections { position: absolute; top: 6px; left: 0; right: 0; height: 22px; cursor: crosshair; touch-action: none; }
  .studio .st-tl-section {
    position: absolute; top: 0; height: 22px; box-sizing: border-box; padding: 0 8px;
    border-radius: 5px; border: 1px solid var(--st-edge); background: #2C3136; color: var(--st-text);
    font-size: 12px; font-weight: 600; display: flex; align-items: center;
    white-space: nowrap; overflow: hidden;
  }
  .studio .st-tl-section-new { opacity: 0.6; pointer-events: none; }
  /* A marker's and a section's name is a button (so the keyboard can reach it),
     and the small one beside it removes it after a yes. */
  .studio .st-tl-tag-btn {
    /* A chip keeps a readable width at every zoom: the full name is its title,
       and a name too long for the chip ends in an ellipsis instead of running
       over the bar it sits on. */
    min-width: 56px; max-width: 150px; min-height: 22px; padding: 0 4px;
    border: 0; border-radius: 4px; background: transparent;
    color: inherit; font: inherit; font-weight: inherit; cursor: pointer;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .studio .st-tl-tag-btn:focus-visible { outline: 2px solid #FFFFFF; outline-offset: 1px; }
  .studio .st-tl-tag-x {
    min-height: 22px; min-width: 22px; padding: 0 4px; border: 0; border-radius: 4px;
    background: transparent; color: var(--st-danger); font: inherit; cursor: pointer;
  }
  .studio .st-tl-tag-x:focus-visible { outline: 2px solid #FFFFFF; outline-offset: 1px; }
  .studio .st-tl-markers { position: absolute; top: 32px; left: 0; right: 0; height: 18px; cursor: copy; }
  .studio .st-tl-marker {
    position: absolute; top: 0; display: flex; align-items: center; gap: 4px;
    font-size: 11px; color: #E8C07A; white-space: nowrap; padding: 0 2px;
    border-left: 2px solid #E8C07A;
  }
  .studio .st-tl-bars {
    position: absolute; bottom: 0; left: 0; right: 0; height: 18px; display: grid; cursor: pointer;
  }
  .studio .st-tl-bar-n {
    font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10px; color: #7E7A72;
    border-left: 1px solid var(--st-line); padding-left: 3px; overflow: hidden; white-space: nowrap;
  }
  .studio .st-tl-playhead {
    position: absolute; top: 0; bottom: 0; width: 2px; background: #FFFFFF; pointer-events: none;
  }
  /* The whole-bar cut a split would make: the bar line the playhead stands on,
     drawn before the button is pressed (and named by the Split label). */
  .studio .st-cut-mark {
    position: absolute; top: 0; bottom: 0; width: 0; pointer-events: none;
    border-left: 1px dashed #E8C07A; opacity: 0.85;
  }
  .studio .st-tl-lane-head { display: flex; align-items: center; gap: 8px; }
  .studio .st-tl-color { width: 8px; align-self: stretch; min-height: 30px; border-radius: 3px; flex: 0 0 auto; }
  .studio .st-tl-lane-name { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
  .studio .st-tl-lane-title {
    font-size: 13px; font-weight: 600; color: var(--st-text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .studio .st-tl-lane-kind { font-size: 11px; color: var(--st-muted); }
  .studio .st-tl-lane-body { position: relative; height: 54px; touch-action: none; }
  /* A clip dragged out of the grid: the lane it is over is outlined and the one
     bar it would take is filled in, so a drop is never a guess. */
  .studio .st-tl-lane-body.st-lane-target {
    outline: 2px solid var(--st-human); outline-offset: -2px; background-color: #1F2328;
  }
  .studio .st-bar-target {
    position: absolute; top: 0; bottom: 0; pointer-events: none;
    background: rgba(242, 165, 65, 0.18);
    border-left: 1px solid var(--st-human); border-right: 1px solid var(--st-human);
  }
  /* The ghost beside the pointer, with the name of the clip being placed. It is a
     child of the page's body rather than of the studio box (see makeDragGhost),
     so this one rule is written outside the studio scope and brings its own
     colours. */
  .st-drag-ghost {
    position: fixed; z-index: 1300; left: 0; top: 0; pointer-events: none;
    display: flex; align-items: center; max-width: 240px; min-height: 44px; padding: 0 12px;
    border-radius: 8px; border: 1px solid #F2A541; background: #24282D; color: #E9E6DF;
    font-family: Inter, system-ui, sans-serif; font-size: 13px; font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  /* A timeline with nothing on it says how a first placement is made. */
  .studio .st-tl-empty { margin: 12px 14px; }
  .studio .st-tl-block {
    /* A block keeps a readable width at every zoom: a one-bar placement is 16 px
       wide at half zoom, so it holds a minimum and its label ends in an ellipsis
       (the full name is its title and its aria-label, and the placement bar
       names it again when it is selected). */
    min-width: 28px;
    position: absolute; top: 7px; height: 40px; box-sizing: border-box; padding: 0 8px;
    border-radius: 6px; border: 2px solid var(--st-human); background: #24282D; color: #121417;
    font: inherit; text-align: left; overflow: hidden; cursor: grab; touch-action: none;
  }
  .studio .st-tl-block-sel { box-shadow: inset 0 0 0 2px #FFFFFF; }
  .studio .st-tl-block-name {
    position: relative; display: block; font-size: 11px; font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .studio .st-tl-block-by { position: relative; display: block; font-size: 10px; opacity: 0.8; white-space: nowrap; }
  .studio .st-tl-wave { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .studio .st-tl-fade { position: absolute; top: 0; bottom: 0; background: #121417; opacity: 0.3; pointer-events: none; }
  .studio .st-tl-fade-in { left: 0; }
  .studio .st-tl-fade-out { right: 0; }
  .studio .st-tl-corner { position: absolute; top: 0; width: 12px; height: 12px; background: #121417; opacity: 0.35; cursor: ew-resize; }
  .studio .st-tl-corner-in { left: 0; border-bottom-right-radius: 6px; }
  .studio .st-tl-corner-out { right: 0; border-bottom-left-radius: 6px; }
  .studio .st-tl-takes { background: #141619; }
  .studio .st-tl-takes-note { margin: 0; }
  .studio .st-tl-takes-body { padding: 8px 10px; min-width: 0; }
  .studio .st-tl-placement {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px;
    padding: 14px 16px; background: var(--st-panel);
  }
  .studio .st-tl-placement-title { margin: 0; font-size: 14px; font-weight: 600; }
  .studio .st-tl-placement-info { font-size: 12px; color: var(--st-muted); }
  .studio .st-tl-placement-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
  .studio .st-tl-placement-help {
    flex-basis: 100%; margin: 0; font-size: 12px; line-height: 1.5; color: var(--st-muted);
  }
  /* The recording lanes widget (A4a): the arrangement's own bar axis under a
     ruler that carries the bars, the section bands and the playhead, and one
     lane per track. A lane is its colour, its name, Arm, M and S, and the clips
     the ARRANGEMENT places on it; the record target (the first armed audio
     track) is drawn tall and red with where it listens and what it hears, and
     every other armed lane only says Armed. Every control is a 44 px target and
     a press on one is a press, never a text selection. Nothing here is a
     command: the arm, mute and solo buttons are the grid's and the mixer
     strip's own. */
  .studio .st-rec-lanes { display: block; min-width: 0; }
  .studio .st-rec-lanes[hidden] { display: none; }
  .studio .st-rec { display: flex; flex-direction: column; min-width: 0; }
  .studio .st-rec-row {
    display: grid; grid-template-columns: 148px minmax(0, 1fr);
    border-bottom: 1px solid var(--st-line-soft);
  }
  .studio .st-rec-side {
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
    min-width: 0; padding: 6px 8px; background: var(--st-head);
    border-right: 1px solid var(--st-line);
    font-size: 11px; line-height: 1.4; color: var(--st-muted);
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  .studio .st-rec-ruler .st-rec-side { border-bottom: 1px solid var(--st-line); }
  .studio .st-rec-ruler-body {
    position: relative; height: 52px; background: var(--st-head);
    border-bottom: 1px solid var(--st-line);
  }
  .studio .st-rec-sections { position: absolute; top: 4px; left: 0; right: 0; height: 20px; }
  .studio .st-rec-section {
    position: absolute; top: 0; height: 20px; box-sizing: border-box; padding: 0 6px;
    border-radius: 4px; border: 1px solid var(--st-edge); background: #2C3136; color: var(--st-text);
    font-size: 11px; font-weight: 600; display: flex; align-items: center;
    white-space: nowrap; overflow: hidden;
  }
  .studio .st-rec-bars {
    position: absolute; bottom: 0; left: 0; right: 0; height: 16px; display: grid;
  }
  .studio .st-rec-bar-n {
    font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10px; color: #7E7A72;
    border-left: 1px solid var(--st-line); padding-left: 2px; overflow: hidden; white-space: nowrap;
  }
  .studio .st-rec-playhead {
    position: absolute; top: 0; bottom: 0; width: 2px; background: #FFFFFF; pointer-events: none;
  }
  .studio .st-rec-color {
    width: 6px; align-self: stretch; min-height: 26px; border-radius: 3px; flex: 0 0 auto;
  }
  .studio .st-rec-lane-name { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
  .studio .st-rec-lane-title {
    font-size: 12px; font-weight: 600; color: var(--st-text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .studio .st-rec-lane-kind { font-size: 10px; color: var(--st-muted); white-space: nowrap; }
  .studio .st-rec-armed-chip {
    flex: 0 0 auto; padding: 0 6px; border-radius: 999px; border: 1px solid var(--st-danger);
    color: var(--st-danger); font-size: 10px; font-weight: 700;
  }
  .studio .st-rec-acts { display: flex; flex-wrap: wrap; gap: 4px; flex: 1 1 100%; }
  .studio .st-rec-acts .st-toggle { flex: 0 0 auto; min-width: 44px; min-height: 44px; }
  /* Every control of the lanes is a 44 px target: the arm button, the meter's
     CLIP chip, the lane's header and a take row's own buttons. */
  .studio .st-rec-arm,
  .studio .st-rec-lane-head,
  .studio .st-rec-clip,
  .studio .st-take-acts .st-btn { min-width: 44px; min-height: 44px; }
  .studio .st-rec-lane-body { position: relative; height: 42px; }
  .studio .st-rec-lane-armed .st-rec-lane-body { background: #1E1512; }
  /* The record target: taller, so A4b's meter and live waveform have the room,
     and red, so the one lane a take lands on is never a guess. */
  .studio .st-rec-lane-target { box-shadow: inset 0 0 0 2px var(--st-danger); }
  .studio .st-rec-lane-target .st-rec-side { background: #2A1A18; }
  .studio .st-rec-block {
    position: absolute; top: 6px; height: 28px; box-sizing: border-box; padding: 0 6px;
    border-radius: 5px; border: 1px solid var(--st-edge); background: #24282D; color: var(--st-text);
    font-size: 11px; display: flex; align-items: center;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .studio .st-rec-target-info {
    position: absolute; left: 8px; right: 8px; bottom: 6px;
    display: flex; flex-wrap: wrap; gap: 4px 10px;
    font-size: 11px; color: var(--st-muted);
  }
  .studio .st-rec-source,
  .studio .st-rec-chain { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .studio .st-rec-note { margin: 10px 12px; font-size: 12px; line-height: 1.5; color: var(--st-muted); }
  /* The record target's dry-input meter (A4b): a fill from the meter's own floor
     (-60 dB) to full scale, the peak the lane holds, and a CLIP chip that latches
     until the operator clears it. What it reads is the DRY input, so the lane says
     so beside it; the chain is named only as what the operator hears. The meter
     itself is not a control, and the chip is a 44 px target. */
  .studio .st-rec-meter {
    display: flex; align-items: center; gap: 8px; flex: 0 1 auto; min-width: 0;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  .studio .st-rec-meter-track {
    position: relative; display: block; flex: 0 0 auto; width: 96px; height: 10px;
    border-radius: 5px; border: 1px solid var(--st-line); background: #14171A; overflow: hidden;
  }
  .studio .st-rec-meter-fill {
    display: block; height: 100%; width: 0; background: var(--st-danger); border-radius: 4px;
  }
  .studio .st-rec-peak {
    font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10px;
    color: var(--st-text); min-width: 46px; white-space: nowrap;
  }
  .studio .st-rec-clip {
    flex: 0 0 auto; padding: 0 8px;
    border-color: var(--st-danger); color: var(--st-danger); font-weight: 700;
  }
  .studio .st-rec-clip[hidden] { display: none; }
  .studio .st-rec-dry { font-size: 10px; color: var(--st-muted); white-space: nowrap; }
  .studio .st-rec-cal { min-height: 44px; }
  /* The live waveform of the pass being recorded: the dry input's own columns,
     drawn by the lanes' one animation frame loop on the record target's lane and
     nowhere else. It is a picture, so a press goes straight through it, and the
     lane is taller so the picture and the meter both have room. */
  .studio .st-rec-lane-target .st-rec-lane-body { height: 128px; }
  /* The canvas sits over the span the pass being recorded covers on the lane's
     own bar axis (the client sets left and width), so the waveform grows under
     the playhead rather than across the whole lane. */
  .studio .st-rec-wave {
    position: absolute; left: 0; top: 0; display: block;
    width: 100%; height: 68px; pointer-events: none;
  }
  /* A phone keeps the lane headers narrow enough to leave a usable bar axis,
     and stacks a lane's header over its own bar row so each lane is one row
     across the page, its meter and controls with it. A take row wraps its
     buttons under the name, so nothing has to be scrolled sideways. */
  @media (max-width: 639px) {
    /* The ruler drops its side column with the lanes: a stacked lane body starts
       at x=0, so the ruler's bar numbers and section bands do too, and the Bars
       label rides inline above them instead of taking a column of its own. */
    .studio .st-rec-ruler { grid-template-columns: minmax(0, 1fr); }
    .studio .st-rec-ruler .st-rec-side { border-right: 0; padding: 2px 8px; }
    .studio .st-rec-lane { grid-template-columns: minmax(0, 1fr); }
    .studio .st-rec-lane .st-rec-side { border-right: 0; border-bottom: 1px solid var(--st-line); }
    .studio .st-rec-meter-track { width: 72px; }
    .studio .st-take { flex-wrap: wrap; }
    .studio .st-take-acts { margin-left: 0; flex: 1 1 100%; }
  }
  /* The pad-and-steps view (the approved design, mockup screen 2): a sampler
     track's clip is a pattern, so opening one shows the kit instead of the
     piano roll. Pads are real buttons, at least 72 px square, and the pad's
     own settings sit under them.

     The view is FOUR widgets since A2 — the pads, the steps, the chop editor
     and the effects — each with a host of its own that a frame can hold. The
     wrapper the handler renders around those hosts is only where they start:
     the shell moves each one into its frame, so the wrapper takes no room and
     carries no look of its own. */
  .studio .st-sampler { display: block; }
  .studio .st-sampler[hidden] { display: none; }
  .studio .st-sampler-host { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .studio .st-sampler-host[hidden] { display: none; }
  .studio .st-sampler-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
  .studio .st-sampler-title { margin: 0; font-size: 15px; font-weight: 700; }
  .studio .st-sampler-meta { font-size: 12px; color: var(--st-muted); }
  .studio .st-sampler-sub { margin: 0; font-size: 12px; font-weight: 600; color: var(--st-muted); }
  .studio .st-bank-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
  .studio .st-bank-tabs .st-toggle { flex: 0 0 auto; min-width: 44px; }
  .studio .st-pad-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  .studio .st-pad {
    position: relative;
    aspect-ratio: 1 / 1; min-height: 72px; padding: 8px; border-radius: 10px;
    border: 2px solid #121417; background: #24282D; color: var(--st-text);
    font: inherit; text-align: left; cursor: pointer;
    display: flex; flex-direction: column; justify-content: space-between; gap: 4px;
  }
  .studio .st-pad:hover { border-color: var(--st-edge); }
  .studio .st-pad.st-pad-sel { border-color: #FFFFFF; }
  /* The live lights (G9). A pad the engine reports sounding, looping or held
     keeps a colour of its own, and a hit flashes it for a moment. Only classes
     and one custom property change, so the button the finger is on is never
     rebuilt. The hit's strength is --hit (0..1, the velocity over 127). */
  .studio .st-pad.st-pad-on { background: #3A3222; }
  .studio .st-pad.st-pad-loop { background: #1E2C3A; }
  .studio .st-pad.st-pad-held { background: #3A2A1C; }
  /* A pad HOLD latched keeps a steady glow and wears a small lock mark in its
     corner: the light says it is still sounding, the mark says why (the latch,
     not a finger, is what holds it). Neither is a flash, so neither animates. */
  .studio .st-pad.st-pad-held { box-shadow: inset 0 0 0 2px var(--st-human); }
  .studio .st-pad-lock {
    position: absolute; top: 6px; right: 6px; width: 10px; height: 10px;
    border-radius: 2px; background: var(--st-human); pointer-events: none;
  }
  .studio .st-pad-lock::before {
    content: ''; position: absolute; left: 1px; top: -6px; width: 8px; height: 7px;
    box-sizing: border-box; border: 2px solid var(--st-human); border-bottom: none;
    border-radius: 5px 5px 0 0;
  }
  .studio .st-pad.st-pad-hit {
    background: #F2A541; border-color: #FFFFFF;
    animation: st-pad-flash 180ms ease-out;
  }
  @keyframes st-pad-flash {
    0% { box-shadow: inset 0 0 0 4px rgba(255, 255, 255, var(--hit, 0.6)); }
    100% { box-shadow: inset 0 0 0 4px rgba(255, 255, 255, 0); }
  }
  /* A browser asked for less motion gets the colour and no animation at all. */
  @media (prefers-reduced-motion: reduce) {
    .studio .st-pad.st-pad-hit {
      animation: none; background: #F2A541;
      box-shadow: inset 0 0 0 4px rgba(255, 255, 255, var(--hit, 0.6));
    }
  }
  .studio .st-pad-num {
    font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10px;
    font-weight: 600; color: var(--st-muted);
  }
  .studio .st-pad-name { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .studio .st-sampler-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  /* The live pad bar: HOLD, ROLL and Pause beside the pads, three controls a
     thumb uses while a pad sounds. Each is a 44 px target that never selects
     its own label and never opens the browser's menu on a long press (the HOLD
     press IS a long press, and ROLL is held too). */
  .studio .st-pad-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
  .studio .st-pad-bar .st-toggle {
    flex: 0 0 auto; min-width: 44px; min-height: 44px;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  /* ROLL's interval sits beside its key on the same bar: a 44 px target too, and
     its own label is never selected or called out. */
  .studio .st-pad-bar .st-roll-interval {
    flex: 0 0 auto; min-width: 44px; min-height: 44px;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  /* The pad mode's three buttons and its scale and key pickers, on the same bar:
     44 px targets each, and none of them selects its own label or calls out a
     menu on a long press. */
  .studio .st-pad-bar .st-pad-modes {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px; flex: 0 0 auto;
  }
  .studio .st-pad-bar .st-pad-choice {
    flex: 0 0 auto; min-width: 44px; min-height: 44px;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  /* The sensitivity popover: its summary is the 44 px control that opens it, and
     its body holds the curve picker and the two ranges. */
  .studio .st-pad-bar .st-pad-sense { flex: 0 0 auto; }
  .studio .st-pad-bar .st-pad-sense-open {
    display: flex; align-items: center; justify-content: center;
    min-width: 44px; min-height: 44px; padding: 0 8px;
    font-size: 12px; color: var(--st-text);
    background: var(--st-head); border: 1px solid var(--st-line); border-radius: 8px;
    cursor: pointer;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  .studio .st-pad-bar .st-pad-sense-body {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px;
    padding: 6px 0 0;
  }
  .studio .st-pad-bar .st-pad-sense-body .st-pad-range { flex: 1 1 140px; }
  .studio .st-pad-bar-note { flex: 1 1 100%; margin: 0; font-size: 11px; color: var(--st-muted); }
  .studio .st-import { position: relative; display: inline-flex; align-items: center; }
  .studio .st-file { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; }
  .studio .st-btn.st-on { background: #3D3420; border-color: #5C4A1E; }
  .studio .st-pad-settings {
    border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-head);
    padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
  }
  .studio .st-pad-title { margin: 0; font-size: 13px; font-weight: 600; }
  /* One group of the pad's settings (Playback, Tuning, Envelope, Mute group,
     Level, Filter): its heading, then its controls. */
  .studio .st-pad-group { display: flex; flex-direction: column; gap: 4px; }
  .studio .st-pad-group-title {
    margin: 0; font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--st-muted);
  }
  .studio .st-pad-fields {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 6px 12px;
  }
  /* One control and, where the setting may be set on the whole bank, the small
     button beside it: the button sits under the control it sends. */
  .studio .st-pad-field { display: flex; flex-direction: column; gap: 2px; }
  .studio .st-pad-note { margin: 2px 0 0; font-size: 11px; color: var(--st-muted); }
  .studio .st-pad-bank {
    min-height: 44px; min-width: 44px; padding: 0 8px;
    font: inherit; font-size: 10px; color: var(--st-muted);
    background: none; border: 1px solid var(--st-line); border-radius: 8px;
    cursor: pointer;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  .studio .st-pad-bank:hover { color: var(--st-text); border-color: var(--st-edge); }
  .studio .st-pad-range { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--st-muted); }
  .studio .st-pad-range-input { width: 100%; min-height: 44px; accent-color: var(--st-human); }
  /* The sample tempo slider's readout: the tempo in BPM, or that the pad has none
     yet, under the control it follows. */
  .studio .st-pad-readout { font-size: 11px; color: var(--st-text); }
  .studio .st-pad-select { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--st-muted); }
  .studio .st-pad-check {
    display: flex; align-items: center; gap: 6px; min-height: 44px;
    font-size: 12px; color: var(--st-muted);
  }
  .studio .st-pad-check input { width: 20px; height: 20px; accent-color: var(--st-human); }
  .studio .st-resample-target { max-width: 180px; }
  /* The chop editor: the sample's waveform, one marker per slice start, and the
     two ways to chop it plus Assign slices to pads. A marker is dragged on the
     SVG itself, so the whole strip takes no touch scrolling. */
  .studio .st-chop {
    border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-head);
    padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
  }
  .studio .st-chop-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
  .studio .st-chop-meta { font-size: 12px; color: var(--st-muted); }
  .studio .st-chop-tools { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }
  .studio .st-chop-sens {
    display: flex; flex-direction: column; gap: 2px; min-width: 150px;
    font-size: 11px; color: var(--st-muted);
  }
  .studio .st-wave {
    display: block; width: 100%; height: 110px; border-radius: 6px;
    background: #121417; touch-action: none;
  }
  .studio .st-slice-marker { cursor: col-resize; stroke-linecap: round; }
  .studio .st-chop-error { margin: 0; font-size: 12px; line-height: 1.45; color: var(--st-danger); }
  .studio .st-chop-read-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .studio .st-step-lock-strip {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    padding: 6px 10px; border: 1px solid var(--st-human); border-radius: 8px;
    background: #2A2418; font-size: 12px;
  }
  .studio .st-step-lock-text { color: var(--st-text); }
  /* The instrument picker (plan 1d, Task 4): a soundfont track's header holds
     the presets of the bank it plays, the chooser when the song has more than
     one bank, that bank's credit, and the two ways to get another one. The
     presets are a real list box, so a pick is one clicked row. */
  .studio .st-instrument { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .studio .st-instrument-title {
    margin: 0; font-size: 11px; font-weight: 600; color: var(--st-muted);
  }
  .studio .st-instrument-current {
    margin: 0; font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 12px; color: var(--st-text);
  }
  .studio .st-preset {
    min-height: 44px; height: auto; max-height: 180px; overflow-y: auto;
    font-size: 12px; padding: 2px;
  }
  .studio .st-preset option { padding: 3px 4px; }
  .studio .st-font-choice { font-size: 12px; }
  .studio .st-credit { margin: 0; font-size: 10px; line-height: 1.4; color: var(--st-muted); }
  .studio .st-font-state { margin: 0; font-size: 11px; line-height: 1.4; color: var(--st-human); }
  .studio .st-note { margin: 0; font-size: 10px; line-height: 1.4; color: var(--st-muted); }
  .studio .st-instrument-acts { flex-wrap: wrap; }
  .studio .st-instrument-acts .st-btn { flex: 1 1 100%; }
  /* An edit the agent made wears the agent's colour, as its clips do. */
  .studio .st-agent-edit {
    outline: 2px solid var(--st-agent); outline-offset: 2px; border-radius: 8px;
  }
  /* The steps, the clip's loop, the patterns and the chain. */
  .studio .st-steps {
    border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-head);
    padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
  }
  .studio .st-pattern-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
  .studio .st-pattern-tabs .st-toggle { flex: 0 0 auto; min-width: 44px; }
  .studio .st-loop { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 12px; }
  .studio .st-swing { min-width: 160px; }
  .studio .st-steps-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
  .studio .st-step-pages { display: flex; gap: 4px; }
  .studio .st-step-pages .st-toggle { flex: 0 0 auto; min-width: 56px; min-height: 44px; font-size: 11px; }
  .studio .st-step-locks { font-size: 11px; color: var(--st-muted); }
  .studio .st-step-strip {
    display: grid; grid-template-columns: repeat(16, minmax(44px, 1fr));
    gap: 4px; overflow-x: auto;
  }
  /* A page of eight positions — a phone, or the steps widget at size m — is
     eight columns, because sixteen columns stay 760 px wide however few cells
     are in them. The strip carries the page size it was drawn for. */
  .studio .st-step-strip[data-page-size="8"] { grid-template-columns: repeat(8, minmax(44px, 1fr)); }
  .studio .st-step {
    position: relative; height: 48px; min-height: 48px; padding: 4px 3px;
    border-radius: 6px; border: 1px solid #2F343A; background: #1B1E22;
    color: var(--st-text); font: inherit; cursor: pointer; overflow: hidden;
  }
  .studio .st-step:nth-child(4n + 1) { background: #22262B; }
  .studio .st-step-on { border-color: #FFFFFF; }
  .studio .st-step-sel { border-color: var(--st-human); }
  .studio .st-step-held { border-color: var(--st-human); background: #2A2418; }
  .studio .st-step-lock { border-color: var(--st-human); background: #2A2418; box-shadow: inset 0 0 0 1px var(--st-human); }
  /* Where the transport is in the steps: an outline inside the cell, so it reads
     apart from a selected step (a border) and from a hit (a white border). */
  .studio .st-step-now {
    outline: 2px solid var(--st-agent); outline-offset: -2px; background: #1A2730;
  }
  .studio .st-step-hint { margin: 0; font-size: 11px; line-height: 1.45; color: var(--st-muted); }
  .studio .st-step-fill { position: absolute; left: 0; right: 0; bottom: 0; background: #B6D98A; }
  .studio .st-step-num {
    position: relative; z-index: 1; font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px;
  }
  .studio .st-step-lock-dot {
    position: absolute; top: 2px; right: 4px; z-index: 1;
    color: var(--st-human); font-weight: 700;
  }
  .studio .st-chain { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; font-size: 12px; }
  .studio .st-chain-label { color: var(--st-muted); }
  .studio .st-chain-empty { color: var(--st-muted); }
  .studio .st-chain-arrow { color: var(--st-muted); }
  .studio .st-chain-chip {
    display: inline-flex; align-items: center; gap: 2px; padding: 2px 6px;
    border: 1px solid #3A3F46; border-radius: 999px; background: #24282D;
  }
  .studio .st-chain-name { font-family: 'JetBrains Mono', ui-monospace, monospace; font-weight: 600; }
  .studio .st-chain-btn {
    padding: 0 3px; border: 0; background: transparent; color: var(--st-muted);
    font: inherit; cursor: pointer;
  }
  .studio .st-chain-btn:disabled { opacity: 0.35; cursor: default; }
  .studio .st-chain-add { margin-left: 4px; }
  /* A pattern's motion lanes: one line per swept pad field, its curve drawn as
     one bar per point, and the Clear that takes the lane off. */
  .studio .st-motion {
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px;
    font-size: 12px; color: var(--st-muted);
  }
  .studio .st-motion-rec { color: var(--st-human); }
  .studio .st-motion-lane {
    display: inline-flex; align-items: center; gap: 6px; padding: 2px 6px;
    border: 1px solid #3A3F46; border-radius: 999px; background: #24282D;
  }
  .studio .st-motion-name { font-family: 'JetBrains Mono', ui-monospace, monospace; font-weight: 600; }
  .studio .st-motion-points { display: inline-flex; align-items: flex-end; gap: 1px; height: 18px; }
  .studio .st-motion-point {
    display: block; width: 2px; min-height: 2px; background: var(--st-human);
    border-radius: 1px;
  }
  .studio .st-motion-count { color: var(--st-muted); font-size: 11px; }
  /* The mixer (plan 1d, Task 10): one strip per track, then the returns, then
     the master, all inside a box that scrolls SIDEWAYS on its own — so a phone
     scrolls the strips and never the page. A strip holds its chain as chips
     (added from a menu, dragged to reorder), its level and pan, its mute and
     solo and its sends; the master's loudness readings, the song's finishing
     target and the limiter's look-ahead sit under the strips. */
  .studio .st-mixer {
    border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-panel);
    display: flex; flex-direction: column; gap: 10px; padding: 12px;
    min-width: 0; max-width: 100%; overflow: hidden;
  }
  .studio .st-mixer[hidden] { display: none; }
  .studio .st-mix-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
  .studio .st-mix-title { margin: 0; font-size: 15px; font-weight: 700; }
  .studio .st-mix-notice {
    flex: 1 1 240px; margin: 0; font-size: 12px; line-height: 1.45; color: var(--st-muted);
  }
  .studio .st-mix-banner {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
    border: 1px solid #2E4D6B; background: #17222D; border-radius: 10px; padding: 10px 12px;
  }
  .studio .st-mix-banner-text { flex: 1 1 260px; margin: 0; font-size: 13px; line-height: 1.45; }
  .studio .st-mix-stopped {
    flex: 1 1 100%; margin: 0; font-size: 12px; line-height: 1.45; color: var(--st-human);
  }
  .studio .st-mix-strips {
    display: flex; align-items: stretch; min-width: 0; max-width: 100%;
    overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch;
    border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-panel);
  }
  .studio .st-strip {
    flex: 0 0 180px; min-width: 0; display: flex; flex-direction: column; gap: 8px;
    padding: 10px; border-right: 1px solid var(--st-line-soft);
  }
  .studio .st-strip:last-child { border-right: 0; }
  .studio .st-strip-master { flex: 0 0 240px; background: var(--st-head); }
  .studio .st-strip-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .studio .st-strip-return .st-color { background: #7A7F87; }
  .studio .st-color-master { background: var(--st-text); }
  .studio .st-strip-name {
    font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .studio .st-strip-fx { display: flex; flex-direction: column; gap: 4px; }
  .studio .st-mix-fx-row { display: flex; align-items: stretch; gap: 3px; }
  .studio .st-mix-chip {
    flex: 1 1 auto; min-width: 0; min-height: 44px; padding: 0 6px; border-radius: 6px;
    border: 1px solid var(--st-edge); background: #24282D; color: var(--st-text);
    font: inherit; font-size: 11px; text-align: left; cursor: grab; touch-action: none;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .studio .st-mix-chip-off { border-style: dashed; color: var(--st-muted); }
  .studio .st-mix-chip-fault { border-color: var(--st-danger); color: var(--st-danger); }
  /* A proposed second amp: it is not in the chain yet, so it is drawn dimmed and
     dashed, with Accept and Decline in place of a bypass switch and a remove. */
  .studio .st-mix-chip-proposed { border-style: dashed; color: var(--st-muted); background: #1E2225; opacity: .7; }
  .studio .st-mix-mini {
    flex: 0 0 auto; min-width: 32px; min-height: 44px; padding: 0 4px; border-radius: 6px;
    border: 1px solid var(--st-edge); background: #24282D; color: var(--st-text);
    font: inherit; font-size: 10px; cursor: pointer;
  }
  .studio .st-mix-mini.st-on { background: #3D3420; border-color: #5C4A1E; }
  .studio .st-mix-add { width: 100%; min-height: 44px; font-size: 11px; }
  .studio .st-mix-range { width: 100%; min-height: 44px; accent-color: var(--st-human); }
  .studio .st-mix-fader, .studio .st-mix-param { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .studio .st-mix-label { font-size: 10px; color: var(--st-muted); }
  .studio .st-mix-value { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px; }
  .studio .st-strip-btns { display: flex; gap: 4px; }
  .studio .st-strip-btns .st-toggle { min-width: 44px; min-height: 44px; }
  .studio .st-strip-sends { display: flex; flex-direction: column; gap: 4px; }
  .studio .st-send { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .studio .st-send-name {
    flex: 1 1 100%; font-size: 10px; color: var(--st-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .studio .st-mix-reads { display: flex; flex-direction: column; gap: 2px; }
  .studio .st-mix-read { display: flex; align-items: baseline; gap: 4px; margin: 0; font-size: 11px; }
  .studio .st-mix-read-label { flex: 1 1 auto; color: var(--st-muted); }
  .studio .st-mix-read-value { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; }
  .studio .st-mix-read-unit { font-size: 10px; color: var(--st-muted); }
  .studio .st-mix-target-line { margin: 4px 0 0; font-size: 11px; color: var(--st-human); }
  .studio .st-mix-editor {
    border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-head);
    display: flex; flex-direction: column; gap: 8px; padding: 10px 12px;
  }
  .studio .st-mix-editor[hidden] { display: none; }
  .studio .st-mix-editor-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
  .studio .st-mix-sub { margin: 0; font-size: 13px; font-weight: 600; }
  .studio .st-mix-editor-where { flex: 1 1 auto; font-size: 11px; color: var(--st-muted); }
  .studio .st-mix-params {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px 12px;
  }
  .studio .st-mix-master {
    border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-head);
    display: flex; flex-direction: column; gap: 8px; padding: 10px 12px;
  }
  .studio .st-mix-targets { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 14px; }
  .studio .st-mix-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; max-width: 100%; }
  .studio .st-mix-pick { min-width: 0; max-width: 100%; }
  .studio .st-mix-number {
    width: 96px; min-height: 44px; border-radius: 8px; border: 1px solid var(--st-edge);
    background: var(--st-bg); color: var(--st-text); font: inherit; font-size: 13px; padding: 0 8px;
  }
  .studio .st-mix-latency { margin: 0; font-size: 11px; color: var(--st-muted); }
  .studio .st-mix-latency[hidden] { display: none; }
  .studio .st-mix-note { margin: 0; font-size: 11px; line-height: 1.45; color: var(--st-muted); }
  /* The compact strip (D3): the aimed track's level, pan, mute, solo and arm in
     a widget of its own beside the full Mixer. It draws with the mixer's own
     controls, so the two surfaces send one set of commands; every control is a
     44 px target and a press on one is never a text selection or a callout. */
  .studio .st-mix-strip-host {
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  .studio .st-mix-strip { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; }
  .studio .st-mix-strip-who { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .studio .st-mix-strip-note {
    margin: 0; padding: 10px 12px; font-size: 13px; line-height: 1.45; color: var(--st-muted);
  }
  @media (max-width: 640px) {
    .studio .st-body { padding: 8px; gap: 8px; }
    .studio .st-pos { font-size: 13px; }
    /* A phone's lane holds eight positions a page (the client pages it by the
       width class and the widget's size), so eight 44 px targets are the row. A
       screen too narrow for that scrolls the row rather than shrinking a
       target. */
    .studio .st-step-strip { grid-template-columns: repeat(8, minmax(44px, 1fr)); overflow-x: auto; }
    .studio .st-mix-strips { overflow-x: auto; overflow-y: hidden; }
    .studio .st-strip { flex: 0 0 152px; }
    .studio .st-strip-master { flex: 0 0 216px; }
  }
` + SHELL_CSS + TRANSPORT_CSS;

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
  return ({ title, content, head }) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8">${
      head || TURBO_RELOAD_HEAD
    }<title>${escapeHtml(title)}</title></head><body>${content}</body></html>`;
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
${PAD_INPUT_SCRIPT}
${MIDI_ROUTE_SCRIPT}
${MIDI_SCRIPT}
${CLIENT_SCRIPT}</script>
    </div>`;

  res.send(render({ title: "Studio", content, head: TURBO_RELOAD_HEAD }));
}

/** One song's studio page. */
function studioPage({ songId, render, res }) {
  const id = escapeHtml(songId);
  const content = `
    <style>${STYLES}</style>
    <div class="studio" data-studio-song="${id}" data-catalog-default="${escapeHtml(CATALOG_DEFAULT)}">
      <!-- The shell (panel/shell.js) moves these four controls into its own top
           bar: the back link is the way to the song list, and the three views
           and the presence row sit beside it. -->
      <header class="st-chrome">
        <a class="st-back" href="/dashboard/studio">← Songs</a>
        <span class="st-title" data-role="title">Song</span>
        <div class="st-modes" role="group" aria-label="View">
          <button class="st-mode" type="button" data-act="mode-session" aria-pressed="true" title="Play the scene grid">Session</button>
          <button class="st-mode" type="button" data-act="mode-arrangement" aria-pressed="false" title="Play the song on the timeline">Arrangement</button>
          <button class="st-mode" type="button" data-act="mode-mixer" aria-pressed="false" title="Mix the tracks, the returns and the master">Mixer</button>
        </div>
        <div class="st-presence" data-role="presence"></div>
      </header>
      <!-- Directly under the top bar: the timeline's tools (shown only while the
           lanes are open), the notices a render can set, and the controllers'
           strip before the shell moves it into the MIDI widget's own header. -->
      <div class="st-strips">
        <div class="st-tl-tools" data-role="tl-tools" hidden>
          <button class="st-btn st-tl-rec" type="button" data-act="rec-timeline" aria-pressed="false" title="Collect the scene launches you play into the timeline">
            <span class="st-tl-rec-dot" aria-hidden="true"></span>Record to timeline
          </button>
          <button class="st-btn" type="button" data-act="split" title="Split the selected placement, or the one under the playhead, at the playhead">Split at playhead</button>
          <button class="st-btn st-zoom" type="button" data-act="zoom-out" aria-label="Zoom out" title="Zoom out: fewer pixels a bar">−</button>
          <span class="st-zoom-read" data-role="zoom" title="The timeline's zoom">1×</span>
          <button class="st-btn st-zoom" type="button" data-act="zoom-in" aria-label="Zoom in" title="Zoom in: more pixels a bar">+</button>
          <span class="st-legend"><span class="st-dot" aria-hidden="true"></span>You</span>
          <span class="st-legend"><span class="st-dot st-dot-agent" aria-hidden="true"></span>Crow agent</span>
        </div>
        <div class="st-notices">
          <span class="st-rec-notice" data-role="rec-notice" hidden></span>
          <span class="st-tl-notice" data-role="timeline-notice" hidden></span>
          <div class="st-perf-notice" data-role="performance-notice" hidden></div>
        </div>
        <div class="st-midi-bar" data-role="midi-bar">
          <button class="st-btn st-small" type="button" data-act="midi-connect" aria-pressed="false"
            title="Let this browser show Studio the MIDI controllers plugged in">Connect controllers</button>
          <button class="st-btn st-small" type="button" data-act="midi-learn" aria-pressed="false"
            title="Click a control, then move a knob or press a pad on your controller">Learn</button>
          <span class="st-midi-state" data-role="midi-state"></span>
        </div>
      </div>
      <!-- The transport bar (panel/transport-bar.js) takes these over, so they
           live here only until it mounts. -->
      <div class="st-transport">
        <button class="st-btn st-transport-btn" type="button" data-act="play" title="Play" aria-label="Play">▶</button>
        <button class="st-btn st-transport-btn" type="button" data-act="stop" title="Stop" aria-label="Stop">■</button>
        <button class="st-btn st-transport-btn" type="button" data-act="pause" title="Pause" aria-label="Pause">❚❚</button>
        <button class="st-btn st-transport-btn st-record-btn" type="button" data-act="record" title="Record into the armed track" aria-label="Record" disabled>●</button>
        <button class="st-btn st-small st-click-btn" type="button" data-act="metronome" aria-pressed="false"
          title="Metronome: a click on every beat while it plays">Click</button>
        <span class="st-rec" data-role="rec-status" hidden></span>
        <label class="st-bpm">bpm
          <input data-role="bpm" type="number" min="20" max="300" step="1" value="120" aria-label="Tempo in beats per minute">
        </label>
        <span class="st-pos" data-role="position">001.1.1</span>
        <span class="st-latency" data-role="output-latency" hidden></span>
      </div>
      <div class="st-out-bar" data-role="output-bar" hidden>
        <label class="st-out-label">Output
          <select class="st-select st-out-select" data-role="output-device" aria-label="Output device"></select>
        </label>
        <span class="st-output-note" data-role="output-note" hidden></span>
      </div>
      <div class="st-body">
        <main class="st-main">
          <section class="st-timeline" data-role="timeline" hidden></section>
          <div class="st-grid-wrap" data-role="grid-wrap">
            <div class="st-grid" data-role="grid"></div>
          </div>
          <p class="st-hint" data-role="hint">Add a track and a scene to start.</p>
          <section class="st-mixer" data-role="mixer" hidden></section><section class="st-mix-strip-host" data-role="mixer-strip" hidden></section>
          <!-- The recording lanes (panel/record-view.js and the client's own
               renderRecLanes): the arrangement's bar axis under a ruler, and
               one lane per track. The shell moves this host into its widget
               frame. -->
          <section class="st-rec-lanes" data-role="rec-lanes" hidden></section>
          <section class="st-recordings" data-role="recordings" hidden></section>
          <section class="st-editor" data-role="editor" hidden></section>
          <section class="st-sampler" data-role="sampler" hidden><div class="st-sampler-host" data-role="sampler-pads" hidden></div><div class="st-sampler-host" data-role="sampler-steps" hidden></div><div class="st-sampler-host" data-role="sampler-chop" hidden></div><div class="st-sampler-host" data-role="sampler-fx" hidden></div><div class="st-sampler-host" data-role="sampler-keyboard" hidden></div></section>
          <section class="st-midi" data-role="midi"></section>
        </main>
        <aside class="st-side">
          <div class="st-side-head">
            <span class="st-dot st-dot-agent"></span>
            <h2>Agent activity &amp; history</h2>
          </div>
          <p class="st-side-note">Every change, yours or the agent's, is one step here. Undo any step; the agent never edits a locked track or the clip you have open.</p>
          <div class="st-history" data-role="history"></div>
          <!-- One wrapper around the Ask label and its box, as a direct child of
               which they are the only two nodes: the shell makes the agent
               widget out of it and the client puts the transcript beside the
               box, never inside it. -->
          <div class="st-ask-body" data-role="ask">
            <label class="st-ask-label" for="st-ask">Ask the agent</label>
            <div class="st-ask">
              <input id="st-ask" type="text" placeholder="Connect a project bot to ask" aria-label="Ask the agent" disabled>
              <button type="button" disabled>Send</button>
            </div>
          </div>
        </aside>
      </div>
      <div class="st-toast" data-role="toast" hidden></div>
      <script type="importmap">{"imports":{"lib0/":"/dashboard/studio/assets/lib0/"}}</script>
      <!-- The resampler is a page-level global (StudioResample): the engine
           client converts a take recorded at another rate with it, and so does
           its worker. -->
      <script>${TAKE_STORE_SCRIPT}
${PAD_INPUT_SCRIPT}
${RECORD_VIEW_SCRIPT}
${PUNCH_SCRIPT}
${MIDI_ROUTE_SCRIPT}
${MIDI_SCRIPT}
${SHELL_LAYOUT_SCRIPT}
${SHELL_SCRIPT}
${TRANSPORT_SCRIPT}
${MIXER_EFFECTS_SCRIPT}
${CLIENT_SCRIPT}</script>
      <script src="/dashboard/studio/assets/resample.js"></script>
    </div>`;

  res.send(render({ title: "Studio", content, head: TURBO_RELOAD_HEAD }));
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