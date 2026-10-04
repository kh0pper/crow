/**
 * Undo journal for calendar/contact changes (spec §5.5): dir 700, files 600, 30 days / 500 entries.
 * Every change is journaled BEFORE its PUT/DELETE (review I12): a journal failure stops the write instead of
 * losing the undo. The post-change etag is filled in afterwards with settleChange(); until then after_etag is
 * null and an undo refuses (changed_since) rather than guess.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { WsError } from "../result.js";

const dir = () => join(process.env.CROW_DATA_DIR || join(process.env.CROW_HOME || join(homedir(), ".crow"), "data"), "workspace-tools", "journal");
const ID = /^j1\.([0-9a-z]{6,12}-[0-9a-f]{12})$/;
const ensureDir = () => { const d = dir(); mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700); return d; };
function writeEntry(d, id, obj) {
  const tmp = join(d, `.${id}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 }); chmodSync(tmp, 0o600);
  renameSync(tmp, join(d, `${id}.json`));
}

/** entry = {kind:"cal"|"card", ref, href, op:"create"|"update"|"delete", before_text|null, after_etag|null} → "j1.<id>" */
export function recordChange(entry) {
  const d = ensureDir();
  const id = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  const { kind, ref, href, op, before_text = null, after_etag = null } = entry;
  writeEntry(d, id, { id, kind, ref, href, op, before_text, after_etag, at: new Date().toISOString() });
  return `j1.${id}`;
}
export function loadChange(versionId) {
  const m = ID.exec(String(versionId)); if (!m) throw new WsError("bad_version_id", "That version_id was not issued by the Workspace tools.");
  try { return JSON.parse(readFileSync(join(dir(), `${m[1]}.json`), "utf8")); }
  catch { throw new WsError("version_gone", "That change is no longer in the undo journal (changes are kept 30 days)."); }
}
/** Record the etag the server gave the object after the journaled write (best effort: a miss leaves null). */
export function settleChange(versionId, afterEtag, { after_etag_posthoc = false } = {}) {
  try { const e = loadChange(versionId); writeEntry(ensureDir(), e.id, { ...e, after_etag: afterEtag ?? null, ...(after_etag_posthoc ? { after_etag_posthoc: true } : {}) }); } catch { /* entry stays null → undo refuses */ }
}
export function pruneJournal({ maxAgeDays = 30, maxEntries = 500 } = {}) {
  let files; try { files = readdirSync(dir()).filter((f) => f.endsWith(".json") || f.endsWith(".tmp")); } catch { return 0; }
  const withTime = files.map((f) => { try { return { f, t: statSync(join(dir(), f)).mtimeMs }; } catch { return null; } }).filter(Boolean).sort((a, b) => b.t - a.t);
  const cutoff = Date.now() - maxAgeDays * 86400000; let removed = 0; let kept = 0;
  for (const x of withTime) {
    const stale = x.f.endsWith(".tmp") ? x.t < Date.now() - 3600e3 : (kept >= maxEntries || x.t < cutoff);
    if (stale) { try { unlinkSync(join(dir(), x.f)); removed++; } catch { /* already gone */ } } else if (x.f.endsWith(".json")) kept++;
  }
  return removed;
}
