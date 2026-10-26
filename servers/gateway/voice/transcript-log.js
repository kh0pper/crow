/**
 * The one-week voice transcript log: an opt-in record of what speech-to-text heard on each voice turn, kept on this
 * instance's own disk for seven days so misheard commands can be quoted from real turns (STT quality work).
 *
 * - OFF unless the Crow voice bot's def has voice.transcript_log === true (normalizeVoiceSettings). Turning it off
 *   deletes the log (the defs-changed reload and the daily sweep both check).
 * - Text only, never audio: per turn { at, device_id, device_name, transcript, heard }. transcript is the final one
 *   (after the STT rewrite), heard what STT wrote before the rewrite (null when it was not rewritten).
 * - Local only: plain files under $CROW_HOME/voice-transcripts/, one per UTC day (YYYY-MM-DD.jsonl), directory 0700 and
 *   files 0600. They are not in crow.db, so the database backups (admin-backup.js, scripts/backup.sh) and instance
 *   sync (SYNCED_TABLES) never carry them.
 * - Expiry: entries older than TRANSCRIPT_LOG_TTL_MS are deleted at every write and by a sweep that runs every hour
 *   (so a log nobody writes to still empties itself, within the hour). Whole days past the cut are removed; the day
 *   the cut falls in is rewritten without its expired lines; a day file dated after tomorrow (a clock that went back)
 *   and a temporary file left by an interrupted rewrite are removed too.
 * - Files are opened without following a symlink, and the directory and files are set to 0700 / 0600 even when they
 *   already existed.
 * - A sweep that cannot read the setting only expires (a passing database error never deletes the week's log); a
 *   setting read as off deletes it.
 * - Bounded: TEXT_MAX characters a field, DAY_MAX_BYTES a day file (further turns that day are not kept).
 * - Nothing here logs the words; a failure is swallowed (it never stops a turn).
 */
import { promises as fsp, constants as FS } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { normalizeVoiceSettings, isVoiceBotDef } from "../../shared/voice-bot.js";
import { resolveCrowHome } from "../../shared/crow-home.js";

export const TRANSCRIPT_LOG_DAYS = 7;
export const TRANSCRIPT_LOG_TTL_MS = TRANSCRIPT_LOG_DAYS * 24 * 60 * 60 * 1000;
export const TRANSCRIPT_LOG_SWEEP_MS = 60 * 60 * 1000;
export const DAY_MAX_BYTES = 5 * 1024 * 1024;
const TEXT_MAX = 2000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const TMP_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl\.[0-9a-f]{12}\.tmp$/;
const NOFOLLOW = FS.O_NOFOLLOW || 0;

/** Is the log on for this (Crow voice bot) def? Anything but an explicit true is off. */
export function transcriptLogOn(def) {
  return !!def && isVoiceBotDef(def) && normalizeVoiceSettings(def).transcript_log === true;
}
/** Where the log lives: $CROW_HOME/voice-transcripts (outside the database). */
export const transcriptLogDir = (env = process.env) => join(resolveCrowHome(env), "voice-transcripts");

const text = (v, n = TEXT_MAX) => (typeof v === "string" ? v.slice(0, n) : "");
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** dir: the log directory; now: the clock (tests). */
export function createTranscriptLog({ dir = transcriptLogDir(), now = Date.now } = {}) {
  // One operation at a time (a write's expiry and the sweep never rewrite the same file at once).
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  async function names() {
    try { return (await fsp.readdir(dir)).sort(); } catch { return []; }
  }
  const dayFiles = async () => (await names()).filter((n) => DAY_FILE.test(n));
  const rm = (name) => fsp.rm(join(dir, name), { force: true });
  /** Every operation runs on the serial chain, so a temporary file found here is always a leftover. */
  const dropTemps = async () => { for (const n of await names()) if (TMP_FILE.test(n)) await rm(n); };

  async function expireNow() {
    await dropTemps();
    const t = now(), cut = t - TRANSCRIPT_LOG_TTL_MS;
    const cutDay = dayOf(cut), lastDay = dayOf(t + 24 * 60 * 60 * 1000);
    for (const name of await dayFiles()) {
      const day = DAY_FILE.exec(name)[1];
      const file = join(dir, name);
      if (day < cutDay || day > lastDay) { await rm(name); continue; }
      if (day > cutDay) continue;
      // The day the cut falls in: keep only its lines that are still inside the week.
      let body = "";
      try { body = await fsp.readFile(file, "utf8"); } catch { continue; }
      const lines = body.split("\n").filter(Boolean);
      const kept = lines.filter((l) => { try { return Date.parse(JSON.parse(l).at) > cut; } catch { return false; } });
      if (kept.length === lines.length) continue;
      if (!kept.length) { await rm(name); continue; }
      const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        const fh = await fsp.open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | NOFOLLOW, 0o600);
        try { await fh.writeFile(`${kept.join("\n")}\n`); } finally { await fh.close(); }
        await fsp.rename(tmp, file);
      } finally { await fsp.rm(tmp, { force: true }); }
    }
  }

  /** One voice turn. device = { id, name? }; transcript = the final text; heard = what STT wrote before a rewrite. */
  function record({ device, transcript, heard = null } = {}) {
    const id = device && typeof device.id === "string" ? device.id : "";
    const said = text(transcript);
    if (!id || !said) return Promise.resolve(false);
    return serial(async () => {
      const at = now();
      const line = `${JSON.stringify({
        at: new Date(at).toISOString(),
        device_id: text(id, 200),
        device_name: typeof device.name === "string" && device.name ? text(device.name, 100) : null,
        transcript: said,
        heard: typeof heard === "string" && heard && heard !== said ? text(heard) : null,
      })}\n`;
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      await fsp.chmod(dir, 0o700);
      const fh = await fsp.open(join(dir, `${dayOf(at)}.jsonl`), FS.O_RDWR | FS.O_APPEND | FS.O_CREAT | NOFOLLOW, 0o600);
      let wrote = false;
      try {
        await fh.chmod(0o600);
        const { size } = await fh.stat();
        // A line torn by a crash is ended first, so it never swallows this one.
        let lead = "";
        if (size > 0) { const b = Buffer.alloc(1); await fh.read(b, 0, 1, size - 1); if (b[0] !== 0x0a) lead = "\n"; }
        const out = lead + line;
        if (size + Buffer.byteLength(out) <= DAY_MAX_BYTES) { await fh.write(out); wrote = true; }
      } finally { await fh.close(); }
      await expireNow();
      return wrote;
    }).catch(() => false);
  }

  /** The expiry alone (the sweep). */
  const expire = () => serial(expireNow).catch(() => {});

  /** Delete every day file (the log was turned off). */
  const clear = () => serial(async () => { for (const n of await names()) if (DAY_FILE.test(n) || TMP_FILE.test(n)) await rm(n); }).catch(() => {});

  /** Every kept entry, oldest first (tests, and an operator reading it back). */
  async function list() {
    const out = [];
    for (const name of await dayFiles()) {
      let body = "";
      try { body = await fsp.readFile(join(dir, name), "utf8"); } catch { continue; }
      for (const l of body.split("\n")) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* a torn line is skipped */ } }
    }
    return out;
  }

  return { record, expire, clear, list, dir };
}

/**
 * The sweep: the log's own expiry, and with the setting off (readDef → the voice def | null) the whole log deleted.
 * A readDef that throws only expires. Runs once soon after boot, then every TRANSCRIPT_LOG_SWEEP_MS (hourly), and on
 * every bot-definition save (post-listen.js). The timers are unref()'d.
 */
export async function sweepTranscriptLog(log, readDef) {
  let def;
  try { def = await readDef(); } catch { await log.expire(); return; }
  if (transcriptLogOn(def)) await log.expire(); else await log.clear();
}
export function startTranscriptLogSweep(log, readDef, { firstMs = 60_000, everyMs = TRANSCRIPT_LOG_SWEEP_MS, setTimeout: st = globalThis.setTimeout, setInterval: si = globalThis.setInterval } = {}) {
  const run = () => { sweepTranscriptLog(log, readDef).catch(() => {}); };
  const t = st(() => { run(); si(run, everyMs)?.unref?.(); }, firstMs);
  t?.unref?.();
}

/** The process-wide log (turn.js and the boot sweep share it). */
export const voiceTranscriptLog = createTranscriptLog();
