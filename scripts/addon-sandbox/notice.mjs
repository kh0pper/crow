/**
 * The bell notices about add-on walls, and the watch for a change made outside
 * Crow.
 *
 *  - The boot notice: one note per boot when the kill switch is set, or when
 *    walls are on here and at least one add-on (or approved data backend) is not
 *    walled. With walls off by default and no kill switch nothing is sent, so an
 *    existing install sees no new bell.
 *  - The first-walled-boot notice: once per host, on the first boot that really
 *    runs walls on. The marker lives in addon-walls.json (`walledNoticeV1`), not
 *    in crow.db, so it survives a database anyone can write.
 *  - The watch: fs.watchFile polling, so it survives the store's rename and a
 *    missing file. It only reports — an edit made outside Crow is named, and the
 *    new modes take effect at the next connect.
 *
 * Every word comes from words.mjs, and the per-entry word from
 * addon-wall-status.js's addonWallWord, so a notice and the status page never
 * call the same add-on two different things. Nothing here throws.
 */
import { unwatchFile, watchFile } from "node:fs";
import {
  addonWallsPath,
  checkAddonWallsOutside,
  readAddonWalls,
  rememberAddonWalls,
  setAddonWallsFlag,
  setAddonWallsOutsideListener,
} from "../../servers/shared/addon-walls-file.js";
import { addonWallWord } from "../../servers/gateway/dashboard/shared/addon-wall-status.js";
import { NOTICE, langOf, langText, fillText, sandboxLine, wallWord } from "./words.mjs";

/** Where the bell note sends the operator. */
export const ADDONS_HREF = "/dashboard/extensions";

/** Walls are on for this host: the per-host default is walled and the kill switch is not set. */
export function wallsOnForHost(env = process.env) {
  const e = env && typeof env === "object" ? env : {};
  return e.CROW_ADDON_WALLS_DEFAULT === "walled" && e.CROW_ADDON_WALLS !== "off";
}

/** The name a notice line shows for one entry: a backend's row name, else its id. */
function lineName(entry) {
  if (entry?.kind === "backend") {
    const name = entry?.name ?? entry?.id;
    return name === undefined || name === null ? "" : String(name);
  }
  const id = entry?.id ?? entry?.name;
  return id === undefined || id === null ? "" : String(id);
}

/**
 * The boot notice, or null when this boot has nothing to say.
 *
 * Sent when the kill switch is set, or when walls are on here and some entry
 * does not read as walled. The last line always states the kill switch.
 */
export function bootNoticeFor({ entries = [], env = process.env, lang = "en" } = {}) {
  const L = langOf(lang);
  const e = env && typeof env === "object" ? env : {};
  const killSwitch = e.CROW_ADDON_WALLS === "off";
  if (!killSwitch && !wallsOnForHost(e)) return null;

  const lines = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    const key = addonWallWord(entry, { env: e });
    if (key === "walled") continue;
    const name = lineName(entry);
    if (!name) continue;
    lines.push(`${name}: ${wallWord(key, L)}`);
  }
  // Walls on and every entry walled: the rollout notice covers that boot, not this one.
  if (!killSwitch && lines.length === 0) return null;

  lines.push(fillText(langText(NOTICE.killSwitchLine, L), {
    state: langText(killSwitch ? NOTICE.stateOn : NOTICE.stateOff, L),
  }));
  return { title: langText(NOTICE.bootTitle, L), body: lines.join("\n") };
}

/**
 * The first-walled-boot notice: one line per add-on, its live sandbox line when a
 * profile is known and its status word otherwise. Never null — the caller decides
 * whether this boot sends it.
 */
export function walledNoticeFor({ entries = [], env = process.env, lang = "en" } = {}) {
  const L = langOf(lang);
  const lines = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object" || entry.kind === "backend") continue;
    const id = lineName(entry);
    if (!id) continue;
    const wall = entry.wall && typeof entry.wall === "object" ? entry.wall : null;
    const profile = wall?.profile && typeof wall.profile === "object" ? wall.profile : null;
    const text = profile
      ? sandboxLine(profile, L, {
        walled: wall?.mode === "walled",
        residuals: Array.isArray(wall?.residuals) ? wall.residuals : [],
      })
      : wallWord(addonWallWord(entry, { env }), L);
    lines.push(`${id}: ${text}`);
  }
  return { title: langText(NOTICE.walledTitle, L), body: lines.join("\n") };
}

/** The dashboard's language for a bell note: its own setting, else English. */
export async function noticeLanguage(db, lang = null) {
  if (lang === "es" || lang === "en") return lang;
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'language'", args: [] });
    return rows?.[0]?.value === "es" ? "es" : "en";
  } catch {
    return "en";
  }
}

/** One bell note. A notification layer that throws never breaks the boot. */
async function send(createNotification, db, notice, extra) {
  const opts = { title: notice.title, body: notice.body, source: "addon-walls", type: "system", ...extra };
  await createNotification(db, opts);
}

/**
 * Record the file as the baseline (unless the boot path already did), send this
 * boot's notices, and mark the first-walled-boot notice as had. Never throws.
 *
 * The gateway takes it baseline BEFORE the add-ons load (post-listen) and passes
 * `rememberBaseline: false` here: an edit made between boot and settle is then
 * reported by the watch, not adopted as this process's own.
 *
 * @returns {Promise<{boot:boolean, walled:boolean}>}
 */
export async function runAddonWallNotices({ db = null, crowHome = null, env = process.env, entries = [], createNotification = null, lang = null, rememberBaseline = true } = {}) {
  const out = { boot: false, walled: false };
  try {
    if (!crowHome) return out;
    // The baseline comes first: an edit made while the gateway was down is not
    // this process's doing, and must not be reported as if it were. A boot that
    // took it before loading the add-ons passes false and keeps the queue.
    if (rememberBaseline) rememberAddonWalls(crowHome);
    if (typeof createNotification !== "function") return out;
    const L = await noticeLanguage(db, lang);

    try {
      const boot = bootNoticeFor({ entries, env, lang: L });
      if (boot) {
        await send(createNotification, db, boot, { action_url: ADDONS_HREF });
        out.boot = true;
      }
    } catch { /* a notice is never worth a failed boot */ }

    if (!wallsOnForHost(env)) return out;
    let flagged = false;
    try { flagged = readAddonWalls(crowHome).walledNoticeV1 === true; } catch { flagged = false; }
    if (flagged) return out;

    try {
      await send(createNotification, db, walledNoticeFor({ entries, env, lang: L }), { action_url: ADDONS_HREF });
      out.walled = true;
      // Only after the note went out: a throw above leaves the next boot to retry.
      try { setAddonWallsFlag(crowHome, "walledNoticeV1", true); } catch { /* the note was sent; the marker retries next boot */ }
    } catch { /* reported next boot */ }
    return out;
  } catch {
    return out;
  }
}

/**
 * Watch addon-walls.json for a change Crow did not write, and hand the diff to
 * `onChange` once per change. Polling (not fs.watch) so the store's rename and a
 * missing file both keep working.
 *
 * @param {object} o
 * @param {Function} [o.watchFile]   test seam, default node:fs watchFile
 * @param {Function} [o.unwatchFile] test seam, default node:fs unwatchFile
 * @returns {Function} stop()
 */
export function startAddonWallsWatch({ crowHome, onChange, intervalMs = 1000, watchFile: watchSeam, unwatchFile: unwatchSeam } = {}) {
  const path = addonWallsPath(crowHome);
  const watch = typeof watchSeam === "function" ? watchSeam : watchFile;
  const unwatch = typeof unwatchSeam === "function" ? unwatchSeam : unwatchFile;
  let stopped = false;

  const listener = () => {
    if (stopped) return;
    let diff = null;
    try { diff = checkAddonWallsOutside(crowHome); } catch { diff = null; }
    report(diff);
  };

  // A change the store finds just before one of Crow's own writes goes to the
  // same place: that write would otherwise make the edit Crow's own baseline,
  // and the poller would never see it.
  const report = (diff) => {
    if (stopped || !diff) return;
    try { if (typeof onChange === "function") onChange(diff); } catch { /* the watch only reports */ }
  };
  setAddonWallsOutsideListener(report);

  try {
    watch(path, { interval: intervalMs, persistent: false }, listener);
  } catch { /* no watch here: the boot notice still ran */ }

  // The poller's own first stat is asynchronous, so a change written right after
  // the watch starts could land before it and never wake it. One check now (the
  // known state is what decides) and a change is never missed.
  try { setImmediate(() => listener()).unref?.(); } catch { /* nothing to check */ }

  return function stop() {
    if (stopped) return;
    stopped = true;
    setAddonWallsOutsideListener(null);
    try { unwatch(path, listener); } catch { /* already gone */ }
  };
}