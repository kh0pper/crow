/**
 * Skills catalog — the Skills panel's one data source (skills panel option C,
 * PR 1). Pure reads: it never writes a skill file, the install record or any
 * other file, so the panel can run it on every render and the report CLI can
 * share it.
 *
 *   parseSkillMeta(text, lang, slug)  friendly title, one-line purpose, triggers, tools
 *   skillSyncPlan({crowHome, appBundles})  what the boot skill sync would do
 *       now, per skill (syncBundleSkills in report mode: decides, writes nothing)
 *   classifySkills({...})  one row per skill name: where it comes from
 *       (built-in / an extension / yours) and its status
 *   isExtensionCopy(entry)  the ONE rule for "this user file is an unedited
 *       extension copy" (the badge here, the Save guard later)
 *
 * No imports beyond node: and bundle-skill-sync.js (itself node:-only), so
 * tests and scripts/ops/skill-sync-report.mjs load it directly. The repo
 * skills dir and the Design kit's skill names are passed in.
 */
import { readFileSync, readdirSync, lstatSync, readlinkSync, openSync, fstatSync, closeSync, constants as fsConstants } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { syncBundleSkills, readSkillLedger, manifestSkillPaths } from "./bundle-skill-sync.js";

const MAX_SKILL_BYTES = 1024 * 1024;
const PURPOSE_MAX = 160;
const SKILL_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

/** The gateway's bundle id rule (routes/bundles.js isValidBundleId). */
export const isValidBundleId = (id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(id) && id.length <= 64;

// ---------------------------------------------------------------- metadata

/** A YAML scalar: quotes removed, never throws. */
function yamlScalar(v) {
  const s = String(v).trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  return s;
}

/** An inline `[a, "b", 'c']` list. */
function yamlInlineList(v) {
  const inner = v.trim().slice(1, -1).trim();
  if (!inner) return [];
  const out = [];
  let cur = "", q = null;
  for (const ch of inner) {
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ",") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(yamlScalar).filter(Boolean);
}

/**
 * The frontmatter as a flat map of top-level keys → string | string[].
 * A minimal line parser (the shape of scripts/sync-skills.js), extended to
 * quoted strings and lists. Anything it doesn't understand is skipped.
 */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { fm[listKey].push(yamlScalar(item[1])); continue; }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) { if (!/^\s/.test(line)) listKey = null; continue; }
    const [, key, raw] = kv;
    listKey = null;
    const v = raw.trim();
    if (!v) { fm[key] = []; listKey = key; continue; }
    if (v.startsWith("[") && v.endsWith("]")) { fm[key] = yamlInlineList(v); continue; }
    if (v === ">" || v === "|" || v === ">-" || v === "|-") { fm[key] = ""; continue; }
    fm[key] = yamlScalar(v);
  }
  return { fm, body: text.slice(m[0].length) };
}

const str = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : typeof v === "string" && v ? [v] : []);

/** Markdown inline markup → plain text. */
const plain = (s) => s
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/\*\*|__|`/g, "")
  .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[.,;:!?]|$)/g, "$1$2")
  .replace(/\s+/g, " ")
  .trim();

function cleanTitle(raw) {
  let t = plain(raw);
  let experimental = false;
  // An em-dash subtitle is a description, not part of the name.
  const dash = t.split(/\s+[—–]\s+/);
  if (dash.length > 1 && dash[0].trim()) t = dash[0].trim();
  for (let i = 0; i < 3; i++) {
    const before = t;
    if (/\s*\(experimental\)\s*$/i.test(t)) { experimental = true; t = t.replace(/\s*\(experimental\)\s*$/i, ""); }
    t = t.replace(/\s*\(F\.\d+(?:\.\d+)*\)\s*$/i, "");
    t = t.replace(/\s+skill$/i, "");
    if (t === before) break;
  }
  return { title: t.trim(), experimental };
}

const humanise = (slug) => {
  const s = String(slug || "").replace(/\.md$/, "").replace(/[-_]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "";
};

function cutPurpose(s) {
  if (s.length <= PURPOSE_MAX) return s;
  const cut = s.slice(0, PURPOSE_MAX);
  const sp = cut.lastIndexOf(" ");
  return (sp > 80 ? cut.slice(0, sp) : cut).replace(/[\s,;:.—–-]+$/, "") + "…";
}

/** The first prose paragraph of the body after its first heading. */
function firstParagraph(body) {
  const lines = body.split(/\r?\n/);
  let inFence = false;
  const para = [];
  for (const line of lines) {
    const l = line.trim();
    if (/^(```|~~~)/.test(l)) { inFence = !inFence; if (para.length) break; continue; }
    if (inFence) continue;
    if (!l) { if (para.length) break; continue; }
    if (/^(#|[-*+]\s|\d+[.)]\s|\||>|<!--|---$)/.test(l)) { if (para.length) break; continue; }
    para.push(l);
  }
  return plain(para.join(" "));
}

/**
 * @param {string} text  the skill file
 * @param {"en"|"es"} [lang]
 * @param {string} [slug]  the file name without .md (for the humanised fallback)
 * @returns {{ title, description, titleLang, descriptionLang, triggers: string[], tools: string[], experimental: boolean }}
 */
export function parseSkillMeta(text, lang = "en", slug = "") {
  const out = { title: "", description: "", titleLang: "en", descriptionLang: "en", triggers: [], tools: [], experimental: false };
  try {
    let s = typeof text === "string" ? text : "";
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    const { fm, body } = parseFrontmatter(s);
    const heading = body.match(/^#\s+(.+?)\s*#*\s*$/m);
    const base = String(slug || "").replace(/\.md$/, "");
    let title = "";
    if (heading) {
      const c = cleanTitle(heading[1]);
      title = c.title;
      out.experimental = c.experimental;
    }
    const yName = str(fm.name);
    if (!title && yName && yName.toLowerCase() !== base.toLowerCase()) title = cleanTitle(yName).title;
    if (!title) title = humanise(base);
    let description = str(fm.description);
    if (!description) description = firstParagraph(heading ? body.slice(heading.index + heading[0].length) : body);
    out.title = title;
    out.description = cutPurpose(plain(description));
    if (lang === "es") {
      const tEs = str(fm.name_es), dEs = str(fm.description_es);
      if (tEs) { out.title = tEs; out.titleLang = "es"; }
      if (dEs) { out.description = cutPurpose(plain(dEs)); out.descriptionLang = "es"; }
    }
    out.triggers = list(fm.triggers);
    out.tools = list(fm.tools).length ? list(fm.tools) : list(fm["allowed-tools"]);
  } catch {
    if (!out.title) out.title = humanise(slug);
  }
  return out;
}

// ---------------------------------------------------------------- the plan

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/** Installed bundle ids (array of "id" / {id}, or the legacy {id: {...}} map), valid ids only. */
export function installedBundleIds(crowHome) {
  const raw = readJson(join(crowHome, "installed.json"));
  const ids = Array.isArray(raw) ? raw.map((e) => (typeof e === "string" ? e : e && e.id)) : raw && typeof raw === "object" ? Object.keys(raw) : [];
  return [...new Set(ids.filter(isValidBundleId))];
}

/**
 * What the boot skill sync would do now, per skill basename. Runs
 * syncBundleSkills in REPORT mode (decides, writes nothing — not even the
 * record) over every installed first-party bundle, exactly like the boot
 * pass (routes/bundles.js) and the report CLI.
 * @returns {{ plan: Map<string, {bundle, skill, action, srcSha, rec}>, lines: Array, installedIds: string[] }}
 */
export function skillSyncPlan({ crowHome, appBundles }) {
  const installedIds = installedBundleIds(crowHome);
  const ledger = readSkillLedger(appBundles);
  const plan = new Map();
  const lines = [];
  for (const id of installedIds) {
    const src = join(appBundles, id);
    const manifest = readJson(join(src, "manifest.json"));
    if (!manifest) continue; // not first-party: the boot sync skips it too
    const { lines: ls } = syncBundleSkills({
      id, src, manifest, installedManifest: readJson(join(crowHome, "bundles", id, "manifest.json")),
      mode: "report", skillsDir: join(crowHome, "skills"), recordPath: join(crowHome, "skill-installs.json"), ledger, log: () => {},
    });
    for (const l of ls) {
      lines.push(l);
      if (!plan.has(l.skill)) plan.set(l.skill, l);
    }
  }
  return { plan, lines, installedIds };
}

const EXT_COPY_ACTIONS = new Set(["same", "adopt", "refresh", "install", "skip-optout"]);
/** The one rule for "an unedited extension copy" (badge + Save guard). */
export function isExtensionCopy(entry) {
  return !!entry && EXT_COPY_ACTIONS.has(entry.action);
}

// ---------------------------------------------------------------- classify

function listSkillFiles(dir) {
  try { return readdirSync(dir).filter((f) => SKILL_FILE_RE.test(f)).sort(); } catch { return []; }
}
function lstatOrNull(p) { try { return lstatSync(p); } catch { return null; } }

/** A regular file's text (after following a link), at most 1 MiB, never a FIFO. */
export function readSkillText(p) {
  let fd = null;
  try {
    fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_SKILL_BYTES) return null;
    return readFileSync(fd, "utf-8");
  } catch { return null; } finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
}

/** The installed bundle whose copy dir a link points into, or null. */
function linkBundle(crowHome, linkPath, installedIds) {
  let target;
  try { target = resolve(dirname(linkPath), readlinkSync(linkPath)); } catch { return null; }
  const root = resolve(crowHome, "bundles") + sep;
  if (!target.startsWith(root)) return null;
  const id = target.slice(root.length).split(sep)[0];
  return installedIds.includes(id) ? id : null;
}

function readRecordSafe(crowHome) {
  const j = readJson(join(crowHome, "skill-installs.json"));
  return j && typeof j === "object" && !Array.isArray(j) ? j : {};
}

/**
 * One row per skill name, in name order.
 * source: "builtin" | "ext" | "yours"; status: "on" | "update" | "behind" |
 * "removed" | "orphan" | "ext-removed" | "replaced" | "needs-kit".
 * Rows with hasFile:false (removed, a not-yet-installed update) have no file
 * to open; PR 1's table does not render them.
 */
export function classifySkills({ crowHome, appBundles, repoDir, lang = "en", kitSkills = [], kitInstalled = false, ack = {} }) {
  const userDir = join(crowHome, "skills");
  const userFiles = listSkillFiles(userDir);
  const repoFiles = new Set(listSkillFiles(repoDir));
  const { plan, installedIds } = skillSyncPlan({ crowHome, appBundles });
  const record = readRecordSafe(crowHome);
  const manifests = new Map();
  const manifestOf = (id) => {
    if (!manifests.has(id)) manifests.set(id, isValidBundleId(id) ? readJson(join(appBundles, id, "manifest.json")) : null);
    return manifests.get(id);
  };
  const bundleName = (id) => { const m = manifestOf(id); return (m && typeof m.name === "string" && m.name) || id; };
  const shippedBy = (id, file) => { const m = manifestOf(id); return !!m && manifestSkillPaths(m).some((p) => p.split("/").pop() === file); };

  const names = new Set([...userFiles, ...repoFiles]);
  for (const [file, e] of plan) if (e.action === "skip-deleted" || e.action === "install") names.add(file);

  const rows = [];
  const userSet = new Set(userFiles);
  for (const file of [...names].sort()) {
    const name = file.replace(/\.md$/, "");
    const entry = plan.get(file) || null;
    const st = userSet.has(file) ? lstatOrNull(join(userDir, file)) : null;
    const row = {
      name, file, source: "builtin", bundle: null, bundleName: null, linked: false,
      replacesBuiltin: false, basedOn: null, status: "on", hasFile: true, path: null, srcSha: entry ? entry.srcSha ?? null : null,
    };
    if (st) {
      row.path = join(userDir, file);
      row.replacesBuiltin = repoFiles.has(file);
      const rec = record[file] && typeof record[file] === "object" ? record[file] : null;
      if (st.isSymbolicLink()) {
        const id = (entry && entry.bundle) || linkBundle(crowHome, row.path, installedIds);
        if (id) Object.assign(row, { source: "ext", bundle: id, linked: true });
        else row.source = "yours";
      } else if (isExtensionCopy(entry)) {
        Object.assign(row, { source: "ext", bundle: entry.bundle });
        if (entry.action === "refresh") row.status = "update";
      } else if (entry && (entry.action === "kept-edited" || entry.action === "kept-unverified")) {
        Object.assign(row, { source: "yours", basedOn: entry.bundle, bundle: entry.bundle });
        const acked = ack[file] && ack[file].srcSha && ack[file].srcSha === entry.srcSha;
        if (entry.action === "kept-edited") row.status = entry.rec && entry.rec.sha256 !== entry.srcSha ? "behind" : "on";
        else row.status = acked ? "on" : "behind";
      } else if (rec && typeof rec.bundle === "string" && !installedIds.includes(rec.bundle)) {
        // An edited copy kept when its extension was uninstalled.
        Object.assign(row, { source: "yours", basedOn: rec.bundle, bundle: rec.bundle, status: "ext-removed" });
      } else if (rec && typeof rec.bundle === "string" && !shippedBy(rec.bundle, file)) {
        Object.assign(row, { source: "yours", basedOn: rec.bundle, bundle: rec.bundle, status: "orphan" });
      } else {
        row.source = "yours";
        // Unrecorded, but sitting in an installed extension's copy dir that its
        // repo manifest no longer lists (a skill an extension stopped shipping).
        const orphanOf = installedIds.find((id) => lstatOrNull(join(crowHome, "bundles", id, "skills", file)) && manifestOf(id) && !shippedBy(id, file));
        if (orphanOf) Object.assign(row, { basedOn: orphanOf, bundle: orphanOf, status: "orphan" });
      }
    } else if (entry && entry.action === "skip-deleted") {
      Object.assign(row, { source: "ext", bundle: entry.bundle, status: "removed", hasFile: false, replacesBuiltin: repoFiles.has(file) });
    } else if (entry && entry.action === "install") {
      Object.assign(row, { source: "ext", bundle: entry.bundle, status: "update", hasFile: false, replacesBuiltin: repoFiles.has(file) });
    } else {
      row.path = join(repoDir, file);
    }
    if (row.bundle) row.bundleName = bundleName(row.bundle);
    if (kitSkills.includes(name) && !kitInstalled && row.status === "on") row.status = "needs-kit";
    rows.push(row);
    // A built-in shadowed by a user file keeps its own row, marked replaced.
    if (st && repoFiles.has(file)) {
      rows.push({ name, file, source: "builtin", bundle: null, bundleName: null, linked: false, replacesBuiltin: false, basedOn: null, status: "replaced", hasFile: true, path: join(repoDir, file), srcSha: null, shadow: true });
    }
  }
  // A row with no file (removed / not yet installed) reads the shipped copy.
  const shippedPath = (id, file) => {
    const m = manifestOf(id);
    const p = m && manifestSkillPaths(m).find((x) => x.split("/").pop() === file);
    return p ? join(appBundles, id, p) : null;
  };
  for (const row of rows) {
    const p = row.hasFile ? row.path : row.bundle ? shippedPath(row.bundle, row.file) : null;
    const text = p ? readSkillText(p) : null;
    const meta = parseSkillMeta(text || "", lang, row.name);
    Object.assign(row, meta);
  }
  return rows;
}
