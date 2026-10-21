/**
 * Bundle skill sync — keeps <CROW_HOME>/skills/<basename> in step with the
 * skill files every installed bundle ships (artifacts smoke fixes, S2 fix 3).
 *
 * Why: install copied a bundle's skills once and the version refresh never
 * touched them again, so bots kept reading the text from whatever release
 * first installed the bundle (the smoke bot ran a skill older than the tools
 * it was offered). This runs on every boot for every installed bundle, and on
 * both install paths.
 *
 * Rules, per skill (dst = <skillsDir>/<basename>; hashes are LF-normalised):
 *   0. dst is a SYMLINK: user-managed. Never written, recorded or notified.
 *   1. dst equals src: record its hash (adopt).
 *   2. dst missing: no record → install it; a record → the user deleted it,
 *      leave it.
 *   3. dst differs and a record with a sha256 exists: equal to the record →
 *      unedited, overwrite; otherwise EDITED → keep, notify once per repo hash.
 *   4. dst differs, no usable record (legacy): its hash is a past shipped
 *      version in the ledger → unedited stale, overwrite; otherwise
 *      undecidable → keep, record {sha256:null, kept:true, reason:"unverified"},
 *      log once and never notify (we cannot tell the user they edited it).
 *
 * The ledger (bundles/skill-history.json) is built at release time by
 * scripts/build-skill-history.mjs, so the runtime never calls git (a
 * git-archive build, a docker or npm install has none). The record
 * (<CROW_HOME>/skill-installs.json) lives outside skills/ so the resolver
 * never sees it. Every write is tmp (pid + random, same dir) + rename, so a
 * second gateway, the Skills panel or a spawning bot never reads a half file.
 *
 * Modes (CROW_SKILL_SYNC, per gateway process): on (default) | report (decide
 * and log, write nothing — not even the record) | off. An unknown value reads
 * as report: a typo must never start writing.
 *
 * No imports beyond node: — scripts/ops/skill-sync-report.mjs and
 * scripts/build-skill-history.mjs load this file directly.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";

/** sha256 of the LF-normalised text (a CRLF checkout of the same text matches). */
export function skillHash(textOrBuf) {
  const s = Buffer.isBuffer(textOrBuf) ? textOrBuf.toString("utf8") : String(textOrBuf);
  return createHash("sha256").update(s.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** The process's mode. Unset → on; anything unrecognised → report. */
export function skillSyncMode(env = process.env) {
  const v = String(env.CROW_SKILL_SYNC ?? "").trim().toLowerCase();
  if (!v || v === "on") return "on";
  if (v === "off" || v === "report") return v;
  return "report";
}

/** The ledger next to the bundles (`<appBundles>/skill-history.json`); {} when absent or unreadable. */
export function readSkillLedger(appBundles) {
  try {
    const j = JSON.parse(readFileSync(join(appBundles, "skill-history.json"), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

/** The manifest's skill paths, minus anything that is not a plain relative path. */
export function manifestSkillPaths(manifest) {
  const list = manifest && Array.isArray(manifest.skills) ? manifest.skills : [];
  return list.filter((p) => typeof p === "string" && p && !isAbsolute(p) && !p.split(/[\\/]/).includes("..")).map((p) => p.replace(/^\.\//, ""));
}

export const ledgerKey = (id, skillPath) => `${id}/${skillPath}`;
const baseOf = (p) => p.split("/").pop();

function readRecord(recordPath) {
  try {
    const j = JSON.parse(readFileSync(recordPath, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

/** tmp (pid + random, same directory) + rename; `mode` is set on the tmp file before the rename. */
export function atomicWrite(path, data, mode = null) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data);
    if (mode != null) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    throw e;
  }
}

function lstatOrNull(p) { try { return lstatSync(p); } catch { return null; } }

/**
 * Sync one bundle's skills.
 * @param {object} o
 * @param {string} o.id           bundle id (the ledger key prefix)
 * @param {string} o.src          directory to copy FROM (the repo bundle at boot, the installed copy at install)
 * @param {object} o.manifest     the manifest whose `skills` are synced
 * @param {object|null} [o.installedManifest]  `"refresh": false` here opts the bundle out
 * @param {"on"|"report"|"off"} [o.mode]
 * @param {string} o.skillsDir
 * @param {string} o.recordPath
 * @param {boolean} [o.install]  an explicit (re)install by the owner: a skill
 *   they deleted is installed again (rule 2's "leave it" is for the silent boot pass)
 * @param {object} [o.ledger]
 * @param {(m: string) => void} [o.log]
 * @returns {{ lines: Array<{bundle, skill, action, srcSha, rec}>, kept: Array<{bundle, skill, reason, notify}> }}
 *   action ∈ same | adopt | install | refresh | kept-edited | kept-unverified |
 *            skip-symlink | skip-deleted | skip-optout
 *   srcSha: the shipped file's hash (null for skip-optout, which never reads
 *   the source); rec: the record entry as it was BEFORE this decision, or
 *   null. The Skills panel reads both (report mode) to show its statuses.
 */
export function syncBundleSkills({ id, src, manifest, installedManifest = null, mode = "on", install = false, skillsDir, recordPath, ledger = {}, log = (m) => console.log(m) }) {
  const lines = [];
  const kept = [];
  if (mode === "off") return { lines, kept };
  const paths = manifestSkillPaths(manifest);
  if (!paths.length) return { lines, kept };
  const write = mode === "on";
  const say = (skill, action, msg, srcSha = null, rec = null) => { lines.push({ bundle: id, skill, action, srcSha, rec }); if (msg) log(`[skills]${write ? "" : " (report)"} ${id}/${skill}: ${msg}`); };
  if (installedManifest && installedManifest.refresh === false) {
    for (const p of paths) say(baseOf(p), "skip-optout", null);
    log(`[skills] ${id}: installed copy opts out of refresh ("refresh": false) — skills left as installed`);
    return { lines, kept };
  }
  const record = readRecord(recordPath);
  let dirty = false;
  const now = new Date().toISOString();
  const put = (skill, entry) => { record[skill] = entry; dirty = true; };
  const copyIn = (dst, buf) => { if (write) atomicWrite(dst, buf); };

  for (const p of paths) {
    const skill = baseOf(p);
    const srcFile = join(src, p);
    let srcBuf;
    try { srcBuf = readFileSync(srcFile); } catch { continue; } // declared but not shipped: nothing to sync
    const hs = skillHash(srcBuf);
    const dst = join(skillsDir, skill);
    const rec = record[skill] && typeof record[skill] === "object" ? record[skill] : null;
    const st = lstatOrNull(dst);

    // 0. symlink: the operator's, never ours.
    if (st && st.isSymbolicLink()) { say(skill, "skip-symlink", "symlink, left alone (user-managed)", hs, rec); continue; }
    // 2. missing.
    if (!st) {
      if (rec && !install) { say(skill, "skip-deleted", null, hs, rec); continue; }
      copyIn(dst, srcBuf);
      put(skill, { bundle: id, sha256: hs, installedAt: now });
      say(skill, "install", "installed", hs, rec);
      continue;
    }
    let hd;
    try { hd = skillHash(readFileSync(dst)); } catch { say(skill, "kept-unverified", "unreadable, left alone", hs, rec); continue; }
    // 1. identical.
    if (hd === hs) {
      if (!rec || rec.sha256 !== hs || rec.kept || rec.bundle !== id) {
        put(skill, { bundle: id, sha256: hs, installedAt: (rec && rec.sha256 === hs && rec.installedAt) || now });
        say(skill, "adopt", rec && rec.sha256 === hs ? null : "already current, recorded", hs, rec);
      } else say(skill, "same", null, hs, rec);
      continue;
    }
    // 3. recorded with what we wrote.
    if (rec && typeof rec.sha256 === "string") {
      if (hd === rec.sha256) {
        copyIn(dst, srcBuf);
        put(skill, { bundle: id, sha256: hs, installedAt: now });
        say(skill, "refresh", "refreshed (unedited)", hs, rec);
      } else {
        // Review 1: only a writing pass may ask for a notification — report
        // mode persists no notifiedFor, so it would repeat every boot.
        const notify = write && rec.notifiedFor !== hs;
        if (notify) put(skill, { ...rec, notifiedFor: hs });
        kept.push({ bundle: id, skill, reason: "edited", notify });
        say(skill, "kept-edited", "edited after install, kept (the new version was not applied)", hs, rec);
      }
      continue;
    }
    // 4. legacy: no usable record.
    const known = Array.isArray(ledger[ledgerKey(id, p)]) && ledger[ledgerKey(id, p)].includes(hd);
    if (known) {
      copyIn(dst, srcBuf);
      put(skill, { bundle: id, sha256: hs, installedAt: now });
      say(skill, "refresh", "refreshed (a past shipped version)", hs, rec);
      continue;
    }
    const quiet = rec && rec.kept === true && rec.reason === "unverified" && rec.srcSha === hs;
    if (!quiet) put(skill, { bundle: id, sha256: null, kept: true, reason: "unverified", notifiedFor: null, srcSha: hs, keptAt: now });
    kept.push({ bundle: id, skill, reason: "unverified", notify: false });
    say(skill, "kept-unverified", quiet ? null : "differs from every shipped version we know, kept (not verified as edited)", hs, rec);
  }
  if (dirty && write) atomicWrite(recordPath, JSON.stringify(record, null, 2) + "\n");
  return { lines, kept };
}

/**
 * Uninstall (review L7): delete only copies provably ours and unedited — the
 * recorded hash, or (no usable record) the installed source or a ledger
 * version. Edited copies and symlinks are kept and logged.
 * @returns {{ removed: string[], kept: string[] }}
 */
export function removeBundleSkills({ id, manifest, src = null, skillsDir, recordPath, ledger = {}, log = (m) => console.log(m) }) {
  const removed = [];
  const kept = [];
  const record = readRecord(recordPath);
  let dirty = false;
  for (const p of manifestSkillPaths(manifest)) {
    const skill = baseOf(p);
    const dst = join(skillsDir, skill);
    const rec = record[skill] && typeof record[skill] === "object" ? record[skill] : null;
    const st = lstatOrNull(dst);
    if (!st) { if (rec) { delete record[skill]; dirty = true; } continue; }
    if (st.isSymbolicLink()) { kept.push(skill); log(`[skills] ${id}/${skill}: symlink, left in place`); continue; }
    let hd = null;
    try { hd = skillHash(readFileSync(dst)); } catch { hd = null; }
    let ours = false;
    if (hd && rec && typeof rec.sha256 === "string") ours = hd === rec.sha256;
    else if (hd) {
      let hs = null;
      try { if (src && existsSync(join(src, p))) hs = skillHash(readFileSync(join(src, p))); } catch { hs = null; }
      ours = hd === hs || (Array.isArray(ledger[ledgerKey(id, p)]) && ledger[ledgerKey(id, p)].includes(hd));
    }
    if (ours) {
      rmSync(dst, { force: true });
      removed.push(skill);
      if (rec) { delete record[skill]; dirty = true; }
    } else {
      kept.push(skill);
      log(`[skills] ${id}/${skill}: edited after install, kept on uninstall`);
    }
  }
  if (dirty) atomicWrite(recordPath, JSON.stringify(record, null, 2) + "\n");
  return { removed, kept };
}

/**
 * The installed bundle that ships skill basename `skill`, or null. Reads the
 * instance's installed.json (array, or the legacy {id: {...}} map) and each
 * bundle's REPO manifest (`<appBundles>/<id>/manifest.json`) — the same
 * manifest the boot sync reads. Bundle ids that are not a plain path segment
 * are ignored.
 */
export function bundleShippingSkill({ crowHome, appBundles, skill }) {
  let installed;
  try { installed = JSON.parse(readFileSync(join(crowHome, "installed.json"), "utf8")); } catch { return null; }
  // Same entry shapes the boot loop accepts: "id" strings or {id} objects.
  const ids = Array.isArray(installed) ? installed.map((e) => (typeof e === "string" ? e : e && e.id)) : Object.keys(installed || {});
  for (const id of ids) {
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(id) || id.includes("..")) continue;
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(appBundles, id, "manifest.json"), "utf8")); } catch { continue; }
    if (manifestSkillPaths(manifest).some((p) => baseOf(p) === skill)) return id;
  }
  return null;
}

/**
 * Record that the owner removed a LINKED skill a bundle ships (Skills panel
 * delete). Without it, boot rule 2 reads "missing, no record" and installs a
 * fresh copy; with it the boot pass reads skip-deleted, exactly as for a
 * deleted copy, and an explicit reinstall (`install: true`) still restores it.
 * An existing entry is left as it is. Refuses (returns false) when the record
 * exists but does not parse — rewriting it from {} would drop every entry.
 * Written in every mode (report included): it records the owner's intent,
 * not a sync decision.
 */
export function recordRemovedLink({ recordPath, skill, bundle }) {
  let record = {};
  if (existsSync(recordPath)) {
    try {
      const j = JSON.parse(readFileSync(recordPath, "utf8"));
      if (!j || typeof j !== "object" || Array.isArray(j)) return false;
      record = j;
    } catch { return false; }
  }
  if (record[skill]) return true;
  record[skill] = { bundle, sha256: null, removedLink: true, removedAt: new Date().toISOString() };
  atomicWrite(recordPath, JSON.stringify(record, null, 2) + "\n");
  return true;
}

/**
 * The one notification the boot pass posts for a kept, EDITED skill (once per
 * shipped version). It links to the skill in the Skills panel with the
 * comparison open, where Restore original (your edit is backed up) and Keep
 * mine live. (Deleting the copy would not bring the new version back: its
 * record stays, so later boots read skip-deleted.)
 */
export function keptSkillNotification({ bundle, skill }) {
  return {
    title: `Your edited skill "${skill}" was kept`,
    body: `A newer version ships with the ${bundle} extension, but your copy was edited after install, so it was not replaced. Open it in Skills to compare it with the new version, restore the original or keep yours.`,
    action_url: `/dashboard/skills?skill=${encodeURIComponent(skill.replace(/\.md$/, ""))}&compare=1`,
    type: "system", source: "bundles",
  };
}

const BACKUPS_KEPT = 5;
const reEscape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Copy an owner's file into <crowHome>/skill-backups before it is replaced; keep the newest 5 per name. */
function backupSkill(crowHome, skill, buf) {
  const dir = join(crowHome, "skill-backups");
  // Only a real directory: a link here could send the owner's text elsewhere.
  if (!lstatOrNull(dir)) { try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return null; } }
  const dst = lstatOrNull(dir);
  if (!dst || !dst.isDirectory()) return null;
  const base = skill.replace(/\.md$/, "");
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
  let name = `${base}.${stamp}Z.md`;
  for (let k = 1; existsSync(join(dir, name)); k++) name = `${base}.${stamp}-${k}Z.md`;
  atomicWrite(join(dir, name), buf, 0o600);
  const mine = new RegExp(`^${reEscape(base)}\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}(-\\d+)?Z\\.md$`);
  const all = readdirSync(dir).filter((f) => mine.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) rmSync(join(dir, old), { force: true });
  return name;
}

/**
 * Write the extension's shipped copy of one skill on an explicit owner click
 * (Skills panel: Apply update, Restore original, Restore). It re-runs the
 * sync's decision for that skill (report mode) and refuses unless the action
 * is one of `expect`, so anything that changed since the page rendered
 * changes nothing. An existing file is backed up first. Written in every
 * sync mode, like recordRemovedLink: it is the owner's intent, not a sync
 * decision. Never writes through a link; refuses an unparseable record.
 * `srcSha`, when given, is the shipped version the page showed: anything
 * else shipping now (the checkout moved under the page) refuses too. A
 * refusal carries the current action and shipped hash, so the caller can
 * tell "already done" (same/adopt with that hash) from a real change.
 * @param {{ crowHome: string, appBundles: string, skill: string, expect: string[], srcSha?: string }} o
 * @returns {{ ok: true, action: string, backup?: string } | { ok: false, error: string, action?: string, srcSha?: string }}
 */
export function installShippedSkill({ crowHome, appBundles, skill, expect, srcSha = undefined }) {
  if (typeof skill !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(skill)) return { ok: false, error: "not-shipped" };
  const id = bundleShippingSkill({ crowHome, appBundles, skill });
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return { ok: false, error: "not-shipped" };
  const recordPath = join(crowHome, "skill-installs.json");
  let record = {};
  if (existsSync(recordPath)) {
    try {
      const j = JSON.parse(readFileSync(recordPath, "utf8"));
      if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, error: "record-unreadable" };
      record = j;
    } catch { return { ok: false, error: "record-unreadable" }; }
  }
  const skillsDir = join(crowHome, "skills");
  const dst = join(skillsDir, skill);
  const st = lstatOrNull(dst);
  if (st && !st.isFile()) return { ok: false, error: "link" };
  const src = join(appBundles, id);
  let manifest, installedManifest = null;
  try { manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")); } catch { return { ok: false, error: "not-shipped" }; }
  try { installedManifest = JSON.parse(readFileSync(join(crowHome, "bundles", id, "manifest.json"), "utf8")); } catch { installedManifest = null; }
  const path = manifestSkillPaths(manifest).find((p) => baseOf(p) === skill);
  if (!path) return { ok: false, error: "not-shipped" };
  const { lines } = syncBundleSkills({ id, src, manifest, installedManifest, mode: "report", skillsDir, recordPath, ledger: readSkillLedger(appBundles), log: () => {} });
  const line = lines.find((l) => l.skill === skill);
  if (!line || !expect.includes(line.action) || (srcSha !== undefined && srcSha !== line.srcSha)) {
    return { ok: false, error: "changed", action: line ? line.action : null, srcSha: line ? line.srcSha : null };
  }
  let srcBuf;
  try { srcBuf = readFileSync(join(src, path)); } catch { return { ok: false, error: "not-shipped" }; }
  let backup;
  // Only the owner's own text is backed up (an unedited copy is the shipped text).
  if (st && (line.action === "kept-edited" || line.action === "kept-unverified")) {
    backup = backupSkill(crowHome, skill, readFileSync(dst));
    if (!backup) return { ok: false, error: "backup-dir" };
  }
  atomicWrite(dst, srcBuf);
  record[skill] = { bundle: id, sha256: skillHash(srcBuf), installedAt: new Date().toISOString() };
  atomicWrite(recordPath, JSON.stringify(record, null, 2) + "\n");
  return backup ? { ok: true, action: line.action, backup } : { ok: true, action: line.action };
}
