/**
 * How the add-on walls actually stand on this computer, in plain words.
 *
 * One module drives every surface that says it — the status page block, the Nest
 * health card and the boot notice — so two of them can never disagree. The words
 * themselves live in scripts/addon-sandbox/words.mjs; the per-add-on decision is
 * `addonWallWord` below, which reads the `wall` record proxy.js keeps beside each
 * connected server and the operator's two switches, and nothing else.
 *
 * The probe is the spawner's own (`probePiSandbox`, cached in this process), so
 * rendering a status never starts an add-on; the probe may run bwrap once and
 * is cached.
 */
import { piSandboxReasonCode, probePiSandbox } from "../../../../scripts/pi-bots/pi_sandbox.mjs";
import { SUMMARY, RESIDUAL_LINE, langOf, langText, fillText, wallWord } from "../../../../scripts/addon-sandbox/words.mjs";
import { escapeHtml } from "./components.js";

/** Test seam: the probe every status surface uses. Null restores the real one. */
let probeOverride = null;
export function _setAddonWallProbeForTest(fn) { probeOverride = typeof fn === "function" ? fn : null; }

/** The launch probe for this render (never throws on a hostile seam). */
export function addonWallProbe() {
  if (probeOverride) {
    try { return probeOverride() || {}; } catch { return {}; }
  }
  try { return probePiSandbox() || {}; } catch { return {}; }
}

/** Test seam: the entries a surface sees. Null reads them from proxy.js. */
let entriesOverride = null;
export function _setAddonWallEntriesForTest(fn) { entriesOverride = typeof fn === "function" ? fn : null; }

/**
 * The entries proxy.js publishes right now. A gateway that has not loaded its
 * add-ons yet (or a build without the export) has none: an empty list, never a
 * guess. Never throws.
 */
export async function addonWallEntriesNow() {
  if (entriesOverride) {
    try { return entriesOverride() || []; } catch { return []; }
  }
  try {
    const proxy = await import("../../proxy.js");
    return typeof proxy.addonWallEntries === "function" ? proxy.addonWallEntries() || [] : [];
  } catch {
    return [];
  }
}

/** The order the non-walled words are counted in, for the summary line. */
const COUNT_ORDER = Object.freeze(["crowDb", "storage", "owner", "failed", "stopped", "killSwitch", "hostOff", "noBwrap"]);

/**
 * One entry's status word key. Precedence:
 *   backend > failed > stopped > (unwalled: the decision's source) > (walled:
 *   crowDb > storage > walled).
 * Nothing here can turn a walled add-on into a walled-looking one it is not:
 * only mode "walled" ever reads as "walled".
 */
export function addonWallWord(entry, { env = process.env } = {}) {
  const e = entry && typeof entry === "object" ? entry : {};
  if (e.kind === "backend") return "backend";
  const wall = e.wall && typeof e.wall === "object" ? e.wall : null;
  const mode = typeof wall?.mode === "string" ? wall.mode : null;
  const status = typeof e.status === "string" ? e.status : null;

  if (mode === "refused") return "failed";
  if (mode === "walled") {
    // A walled add-on that stopped after it connected did not keep running
    // inside its wall; one that errored never ran there at all.
    if (status === "disconnected") return "stopped";
    if (status && status !== "connected") return "failed";
    if (wall?.profile?.crowDb === true) return "crowDb";
    if (Array.isArray(wall?.residuals) && wall.residuals.some((r) => r && r.kind === "storage")) return "storage";
    return "walled";
  }

  const source = typeof wall?.source === "string" ? wall.source : null;
  if (source === "kill-switch") return "killSwitch";
  if (source === "no-bwrap") return "noBwrap";
  if (source === "owner") return "owner";
  if (source === "default") return "hostOff";
  if (source === "refused") return "failed";
  // The decision said walled but this run is not: it never ran walled.
  if (source === "walled") return "failed";

  // No record at all: only the operator's switches, then the owner's own file,
  // can free an add-on, so those are the only honest words left.
  if (env && env.CROW_ADDON_WALLS === "off") return "killSwitch";
  if (env && env.CROW_ADDON_WALLS_DEFAULT !== "walled") return "hostOff";
  return "owner";
}

/** One entry as the status surfaces carry it. */
function statusRow(entry, env, lang) {
  const id = entry?.id === undefined || entry?.id === null ? "" : String(entry.id);
  const name = entry?.name === undefined || entry?.name === null ? id : String(entry.name);
  const kind = entry?.kind === "builtin" ? "builtin" : entry?.kind === "backend" ? "backend" : "addon";
  const wordKey = addonWallWord(entry, { env });
  return { id: id || name, name, kind, wordKey, word: wallWord(wordKey, lang) };
}

/**
 * The whole picture: one summary sentence, one word per entry, one residual line.
 *
 * @returns {{code:string, sentence:string, severity:"ok"|"info"|"warn",
 *            entries:Array, backends:Array, residualLine:string}}
 */
export function addonWallStatus({ probe = null, env = process.env, entries = [], lang = "en" } = {}) {
  const L = langOf(lang);
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === "object") : [];
  const counted = list.filter((e) => e.kind !== "backend");
  const entriesOut = counted.map((e) => statusRow(e, env, L));
  const backends = list.filter((e) => e.kind === "backend").map((e) => statusRow(e, env, L));

  const source = env && typeof env === "object" ? env : {};
  const killSwitch = source.CROW_ADDON_WALLS === "off";
  const hostWalled = source.CROW_ADDON_WALLS_DEFAULT === "walled";
  const probeCode = piSandboxReasonCode(probe || addonWallProbe(), "auto");

  let code;
  let sentence;
  let severity;
  if (killSwitch) {
    code = "kill-switch";
    sentence = langText(SUMMARY.killSwitch, L);
    severity = "warn";
  } else if (probeCode === "no-bwrap") {
    // No bwrap here: no add-on runs walled, whatever the owner chose. Only a host
    // that expected walls has something wrong with it.
    code = "no-bwrap";
    sentence = langText(SUMMARY.noBwrap, L);
    severity = hostWalled ? "warn" : "info";
  } else if (!hostWalled) {
    code = "host-off";
    sentence = langText(SUMMARY.hostOff, L);
    severity = "info";
  } else if (entriesOut.length === 0) {
    code = "none";
    sentence = langText(SUMMARY.none, L);
    severity = "ok";
  } else if (entriesOut.every((e) => e.wordKey === "walled")) {
    code = "walled";
    sentence = langText(SUMMARY.allWalled, L);
    severity = "ok";
  } else {
    const walled = entriesOut.filter((e) => e.wordKey === "walled").length;
    let text = fillText(langText(SUMMARY.counts, L), { n: walled, m: entriesOut.length });
    for (const key of COUNT_ORDER) {
      const count = entriesOut.filter((e) => e.wordKey === key).length;
      if (count > 0) text += `; ${count} ${wallWord(key, L)}`;
    }
    code = "mixed";
    sentence = text;
    severity = entriesOut.some((e) => e.wordKey === "failed") ? "warn" : "info";
  }

  return { code, sentence, severity, entries: entriesOut, backends, residualLine: langText(RESIDUAL_LINE, L) };
}

/** The status block: the sentence, one line per entry (backends by name), the residual. */
export function renderAddonWallStatus(opts = {}) {
  const lang = opts.lang ?? "en";
  const status = addonWallStatus({ ...opts, lang });
  const rows = [
    ...status.entries.map((e) => `${e.id}: ${e.word}`),
    ...status.backends.map((b) => `${b.name}: ${b.word}`),
  ];
  const list = rows.length
    ? `<ul class="crow-addon-wall-status-list" style="margin:0.25rem 0 0;padding-left:1.1rem">${rows
      .map((row) => `<li>${escapeHtml(row)}</li>`).join("")}</ul>`
    : "";
  return `<div class="crow-addon-wall-status" id="crow-addon-wall-status" style="margin:0 0 1.5rem">
      <p id="crow-addon-wall-status-line" style="margin:0;font-weight:600">${escapeHtml(status.sentence)}</p>
      ${list}
      <p class="crow-addon-wall-status-residual" style="margin:0.25rem 0 0;color:var(--crow-text-secondary);font-size:0.9rem">${escapeHtml(status.residualLine)}</p>
    </div>`;
}