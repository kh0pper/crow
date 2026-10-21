/**
 * Skills Panel — Browse, view, edit, and manage AI skill files
 *
 * Skills are markdown files that define AI behavior and workflows.
 * - Repo skills: skills/*.md (shipped with Crow, read-only here)
 * - User skills: <CROW_HOME>/skills/*.md (user overrides, editable)
 * User skills take precedence over repo skills with the same filename.
 *
 * Write safety (skills audit A11/A14/A15): names are validated before any
 * write, every write is tmp + rename (atomicWrite), and a user skill that is a
 * SYMLINK is never written through — the edit page offers "Make my own copy"
 * instead, and deleting one leaves a tombstone in skill-installs.json so the
 * boot skill sync does not quietly re-install a copy.
 */

import { escapeHtml, section, formField, badge, dataTable } from "../shared/components.js";
import { t, tJs, fill } from "../shared/i18n.js";
import { existsSync, readFileSync, unlinkSync, readdirSync, lstatSync, openSync, fstatSync, closeSync, constants as fsConstants } from "fs";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { resolveCrowHome } from "../../../shared/crow-home.js";
import { atomicWrite, bundleShippingSkill, recordRemovedLink } from "../../bundle-skill-sync.js";
import { normalizeSkillName } from "../../../../scripts/pi-bots/skill_proposals.mjs";
import { invalidateContextCache } from "../../../memory/crow-context.js";
import { classifySkills, parseSkillMeta, anyBundleShipping } from "../../skills-catalog.js";
import { isWritingRulesTemplate } from "../../../shared/writing-rules.js";
import { installedKitDir } from "../../../shared/design-kit.js";
import { getInstanceSyncManager } from "../../../sharing/server.js";
import { emitOrQueue } from "../../../shared/sync-emit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_SKILLS_DIR = join(__dirname, "../../../../skills");
const APP_BUNDLES_DIR = join(__dirname, "../../../../bundles");
// Resolved via CROW_HOME (at call time) so a co-hosted instance reads and
// writes its OWN user skills, never the primary instance's.
const userSkillsDir = () => join(resolveCrowHome(), "skills");
const skillRecordPath = () => join(resolveCrowHome(), "skill-installs.json");
// A skill is prompt text; anything bigger than this is not one, and reading
// it (or a FIFO / device a link points at) must never stall the gateway.
const MAX_SKILL_BYTES = 1024 * 1024;

/** A request field as a string, or null when absent / repeated (an array) / not a string. */
function one(v) {
  return typeof v === "string" ? v : null;
}

/** True for a listable / editable skill file name: ends .md, not dot-leading. */
const SKILL_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

/**
 * An EXISTING skill file name from a request, after the historic sanitizer:
 * a basename of [A-Za-z0-9._-], ending .md, not dot-leading (".md" and
 * ".hidden.md" are refused). Lenient on case and dots so files made before
 * the create rule tightened stay editable. null when invalid.
 */
function existingSkillName(raw) {
  if (typeof raw !== "string") return null;
  const safe = basename(raw).replace(/[^a-z0-9._-]/gi, "");
  return SKILL_FILE_RE.test(safe) ? safe : null;
}

/** Accents off ("Café" → "Cafe", "ñ" → "n"), for file names and comparisons. */
const foldAccents = (s) => String(s).normalize("NFKD").replace(/\p{M}/gu, "");
/** A title compared the way a person reads it: accents and case folded, spaces collapsed. */
const titleKey = (s) => foldAccents(s).toLowerCase().replace(/\s+/g, " ").trim();

/**
 * A NEW skill's file name from the create form: accents folded, lowercase,
 * whitespace runs → "-", anything outside [a-z0-9_-] dropped, leading and
 * trailing "-"/"_" trimmed, then the bot resolver's own normalizeSkillName
 * must accept it unchanged, so a bot can always load what the panel made
 * ("My Test Skill" → my-test-skill.md, "Café notes" → cafe-notes.md). A name
 * with letters or digits only in another script ("日本") gets the first free
 * skill-<n>.md (`isTaken(file)` says which are used); its title keeps the
 * name as typed. null when the name has no letter or digit at all.
 * @returns {{ file: string, title: string } | null}
 */
export function newSkillName(raw, isTaken = () => false) {
  if (typeof raw !== "string") return null;
  let title = basename(raw).trim();
  if (title.toLowerCase().endsWith(".md")) title = title.slice(0, -3).trim();
  const s = foldAccents(title).toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").replace(/^[-_]+|[-_]+$/g, "");
  if (s) return normalizeSkillName(s) === s ? { file: s + ".md", title } : null;
  if (!/[\p{L}\p{N}]/u.test(title) || title.length > 80) return null;
  for (let n = 1; n < 10000; n++) if (!isTaken(`skill-${n}.md`)) return { file: `skill-${n}.md`, title };
  return null;
}

/** The text a create writes: an optional purpose in frontmatter, then a heading unless the instructions bring one. */
function newSkillText({ title, purpose, content }) {
  const p = (purpose || "").replace(/\s+/g, " ").trim();
  const fm = p ? `---\ndescription: ${/^[\s\-?[\]{}#&*!|>'"%@`]|[:#]/.test(p) ? JSON.stringify(p) : p}\n---\n` : "";
  const body = toLf(content);
  if (/^\s*#\s/.test(body)) return fm + body;
  return `${fm}# ${title}\n\n${body.replace(/^\n+/, "")}${body.endsWith("\n") ? "" : "\n"}`;
}

/** The skill files in a directory, or [] when it can't be read. */
function readdirSafe(dir) {
  try { return readdirSync(dir).filter((f) => SKILL_FILE_RE.test(f)).sort(); } catch { return []; }
}

function lstatOrNull(p) {
  try { return lstatSync(p); } catch { return null; }
}

/** LF line endings (browsers submit textareas with CRLF). */
const toLf = (text) => text.replace(/\r\n/g, "\n");

/** Write a skill file (tmp + rename), keeping an existing regular file's mode. */
function writeSkill(filePath, text) {
  const st = lstatOrNull(filePath);
  atomicWrite(filePath, toLf(text), st && st.isFile() ? st.mode & 0o777 : null);
}

const NOTICE_CODES = {
  "invalid-name": "skills.errorInvalidName",
  exists: "skills.errorExists",
  empty: "skills.errorEmpty",
  "not-found": "skills.errorNotFound",
  "link-unreadable": "skills.errorLinkUnreadable",
  "record-unreadable": "skills.errorRecordUnreadable",
};

/**
 * A skill's text, or null. Only a regular file (after following a link) of at
 * most MAX_SKILL_BYTES is read: a link to a directory, a missing target, a
 * FIFO or a device yields null instead of an error or a blocked event loop.
 */
function readSkillContent(filePath) {
  let fd = null;
  try {
    // Open non-blocking and check the OPENED file, so a target swapped
    // between a check and the read can never block on a FIFO.
    fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_SKILL_BYTES) return null;
    return readFileSync(fd, "utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** The Design kit's skill names (bot-world.mjs), loaded lazily: [] if it can't load. */
let kitSkillsCache = null;
async function kitSkills() {
  if (kitSkillsCache) return kitSkillsCache;
  try { kitSkillsCache = [...(await import("../../../../scripts/pi-bots/bot-world.mjs")).KIT_SKILLS]; } catch { kitSkillsCache = []; }
  return kitSkillsCache;
}

/** Status → [i18n key, tone]. "on" shows nothing. */
const STATUS = {
  update: ["skills.st.update", "info"],
  behind: ["skills.st.behind", "warning"],
  removed: ["skills.st.removed", "error"],
  orphan: ["skills.st.orphan", "warning"],
  "ext-removed": ["skills.st.extRemoved", "muted"],
  replaced: ["skills.st.replaced", "muted"],
  "needs-kit": ["skills.st.needsKit", "muted"],
};

const SKILLS_TABLE_CSS = `<style>
  .sk-title { font-weight: 600; }
  .sk-purpose { color: var(--crow-text-secondary); font-size: 0.85rem; margin-top: 0.15rem; }
  .sk-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; }
  .sk-chip { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.75rem; border: 1px solid var(--crow-border); background: var(--crow-bg-elevated); color: var(--crow-text-secondary); }
  .sk-chip-ext, .sk-chip-yours { background: var(--crow-accent-muted); color: var(--crow-text); border-color: transparent; }
  .sk-st { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.75rem; }
  .sk-st::before { content: ""; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: currentColor; }
  .sk-st-info { color: var(--crow-info); }
  .sk-st-warning { color: var(--crow-warning); }
  .sk-st-error { color: var(--crow-error); }
  .sk-st-muted { color: var(--crow-text-muted); }
</style>`;

export default {
  id: "skills",
  name: "Skills",
  icon: "skills",
  route: "/dashboard/skills",
  navOrder: 35,
  category: "tools",

  async handler(req, res, { db, layout, lang }) {
    // Handle POST actions
    // Set by a refused create: the list renders again with the form filled in.
    let createState = null;
    if (req.method === "POST") {
      const body = req.body || {};
      // A repeated field arrives as an array (urlencoded, extended:false) —
      // e.g. the old nested Save/Delete forms posted action=save&action=delete.
      // Refuse it outright rather than fall through to a 200 list render.
      for (const k of ["action", "filename", "content", "sectionKey", "purpose"]) {
        if (body[k] !== undefined && typeof body[k] !== "string") {
          // text/html so Turbo shows it (a text/plain 4xx is dropped silently).
          res.status(400);
          return layout({ title: t("skills.pageTitle", lang), content: section(t("skills.pageTitle", lang), `<p>${escapeHtml(t("skills.errorBadRequest", lang))}</p><a href="/dashboard/skills" class="btn btn-secondary">${t("skills.back", lang)}</a>`) });
        }
      }
      const action = one(body.action);
      const editUrl = (name) => "/dashboard/skills?edit=" + encodeURIComponent(name) + "&source=user";
      const back = (code) => { res.redirectAfterPost("/dashboard/skills" + (code ? "?error=" + code : "")); };

      if (action === "save") {
        // Edits an EXISTING user skill only (audit A12): new skills come from
        // "create", copies of built-ins from "override".
        const safeName = existingSkillName(body.filename);
        const content = one(body.content);
        if (!safeName) return back("invalid-name");
        const filePath = join(userSkillsDir(), safeName);
        const st = lstatOrNull(filePath);
        if (st && st.isSymbolicLink()) {
          // Never write through a link (it points into an extension's copy,
          // which a version refresh overwrites). The edit page offers a copy.
          res.redirectAfterPost(editUrl(safeName));
          return;
        }
        if (!st || !st.isFile()) return back("not-found");
        if (!content || !content.trim()) return back("empty");
        writeSkill(filePath, content);
        res.redirectAfterPost("/dashboard/skills");
        return;
      }

      if (action === "override") {
        // Copy a built-in into the user dir (the confirm is on the button).
        // The text is read server-side, never round-tripped through the form.
        const safeName = existingSkillName(body.filename);
        if (!safeName) return back("invalid-name");
        const text = readSkillContent(join(REPO_SKILLS_DIR, safeName));
        if (text === null) return back("not-found");
        const filePath = join(userSkillsDir(), safeName);
        if (lstatOrNull(filePath)) return back("exists");
        writeSkill(filePath, text);
        res.redirectAfterPost(editUrl(safeName));
        return;
      }

      if (action === "copy-link") {
        // "Make my own copy": replace the link ENTRY with a regular file holding
        // the text it points at. rename(2) over a symlink replaces the link
        // itself, never its target.
        const safeName = existingSkillName(body.filename);
        if (!safeName) return back("invalid-name");
        const filePath = join(userSkillsDir(), safeName);
        const st = lstatOrNull(filePath);
        if (!st || !st.isSymbolicLink()) return back("not-found");
        const text = readSkillContent(filePath);
        if (text === null) return back("link-unreadable");
        writeSkill(filePath, text);
        res.redirectAfterPost(editUrl(safeName));
        return;
      }

      if (action === "delete") {
        const safeName = existingSkillName(body.filename);
        if (safeName) {
          const filePath = join(userSkillsDir(), safeName);
          const st = lstatOrNull(filePath); // lstat: a dangling link is still deletable
          if (st && st.isSymbolicLink()) {
            // A link an installed extension ships: tombstone it first, so the
            // boot sync does not install a fresh copy in its place (A15).
            const bundle = bundleShippingSkill({ crowHome: resolveCrowHome(), appBundles: APP_BUNDLES_DIR, skill: safeName });
            if (bundle && !recordRemovedLink({ recordPath: skillRecordPath(), skill: safeName, bundle })) {
              return back("record-unreadable");
            }
            unlinkSync(filePath); // the link only, never its target
          } else if (st && st.isFile()) {
            unlinkSync(filePath);
          }
        }
        res.redirectAfterPost("/dashboard/skills");
        return;
      }

      if (action === "create") {
        // A refused create re-renders the page (422) with everything typed
        // still in the form; a redirect would throw it away (audit A18).
        const typed = { filename: one(body.filename) ?? "", purpose: one(body.purpose) ?? "", content: one(body.content) ?? "" };
        const refuse = (code, existing = null, shippedBy = null) => { createState = { code, typed, existing, shippedBy }; res.status(422); };
        const onDisk = (f) => !!lstatOrNull(join(userSkillsDir(), f)) || existsSync(join(REPO_SKILLS_DIR, f));
        // A name any extension ships (installed or not) is taken too: the
        // extension's copy would collide with it on install.
        const isTaken = (f) => onDisk(f) || !!anyBundleShipping(APP_BUNDLES_DIR, f);
        const named = newSkillName(typed.filename, isTaken);
        const shipper = named && !onDisk(named.file) ? anyBundleShipping(APP_BUNDLES_DIR, named.file) : null;
        if (!named) refuse("invalid-name");
        else if (onDisk(named.file)) refuse("exists", { file: named.file, source: lstatOrNull(join(userSkillsDir(), named.file)) ? "user" : "repo" });
        else if (shipper) refuse("shipped", null, shipper.name);
        else {
          // The same title under another file name is the same skill to a
          // person: check yours and the built-ins.
          const key = titleKey(named.title);
          const titleOf = (dir, f) => titleKey(parseSkillMeta(readSkillContent(join(dir, f)) || "", "en", f.replace(/\.md$/, "")).title);
          const userClash = readdirSafe(userSkillsDir()).find((f) => titleOf(userSkillsDir(), f) === key);
          const repoClash = userClash ? null : readdirSafe(REPO_SKILLS_DIR).find((f) => titleOf(REPO_SKILLS_DIR, f) === key);
          if (userClash) refuse("exists", { file: userClash, source: "user" });
          else if (repoClash) refuse("exists", { file: repoClash, source: "repo" });
          else if (!typed.content.trim()) refuse("empty");
          else {
            writeSkill(join(userSkillsDir(), named.file), newSkillText({ title: named.title, purpose: typed.purpose, content: typed.content }));
            res.redirectAfterPost("/dashboard/skills?created=" + encodeURIComponent(named.file));
            return;
          }
        }
      }

      if (action === "save-writing-rules") {
        const content = one(body.content) ?? "";
        await db.execute({
          sql: "UPDATE crow_context SET content = ?, updated_at = datetime('now') WHERE section_key = ? AND device_id IS NULL AND project_id IS NULL",
          args: [content, "writing_style"],
        });
        invalidateContextCache();
        // D4: emit the post-UPDATE row so this dashboard edit replicates to peers.
        // Zero rows → section absent, skip emit.  Null manager → sharing not initialized, skip silently.
        const syncMgr = getInstanceSyncManager?.();
        try {
          const { buildCrowContextWireRow } = await import("../../../sharing/instance-sync.js");
          const { rows: emitRows } = await db.execute({
            sql: "SELECT * FROM crow_context WHERE section_key = ? AND device_id IS NULL AND project_id IS NULL",
            args: ["writing_style"],
          });
          if (emitRows.length > 0) {
            emitOrQueue(syncMgr, db, "crow_context", "update", buildCrowContextWireRow(emitRows[0])).catch(() => {});
          }
        } catch {}
        res.redirectAfterPost("/dashboard/skills");
        return;
      }

      if (action === "save-context-section") {
        const sectionKey = one(body.sectionKey);
        const content = one(body.content) ?? "";
        const EDITABLE_SECTIONS = [
          "identity", "memory_protocol", "research_protocol",
          "session_protocol", "transparency_rules", "key_principles",
          "writing_style",
        ];
        if (!EDITABLE_SECTIONS.includes(sectionKey)) {
          res.redirectAfterPost("/dashboard/skills");
          return;
        }
        await db.execute({
          sql: "UPDATE crow_context SET content = ?, updated_at = datetime('now') WHERE section_key = ? AND device_id IS NULL AND project_id IS NULL",
          args: [content, sectionKey],
        });
        invalidateContextCache();
        // D4: emit the post-UPDATE row so this dashboard edit replicates to peers.
        // Zero rows → section absent, skip emit.  Null manager → sharing not initialized, skip silently.
        const syncMgr = getInstanceSyncManager?.();
        try {
          const { buildCrowContextWireRow } = await import("../../../sharing/instance-sync.js");
          const { rows: emitRows } = await db.execute({
            sql: "SELECT * FROM crow_context WHERE section_key = ? AND device_id IS NULL AND project_id IS NULL",
            args: [sectionKey],
          });
          if (emitRows.length > 0) {
            emitOrQueue(syncMgr, db, "crow_context", "update", buildCrowContextWireRow(emitRows[0])).catch(() => {});
          }
        } catch {}
        res.redirectAfterPost("/dashboard/skills");
        return;
      }
    }

    // Handle writing rules edit view
    const query = createState ? {} : (req.query || {});
    const editParam = one(query.edit); // a repeated ?edit= reads as absent (was a 500)

    // ?skill=<name> (Bot Builder's off chip links here): open that skill's
    // page — yours first, then the built-in; an unknown name opens the list.
    const skillParam = one(query.skill);
    if (skillParam !== null && !editParam) {
      const base = normalizeSkillName(skillParam);
      const file = base ? base + ".md" : null;
      if (file && lstatOrNull(join(userSkillsDir(), file))) return res.redirect("/dashboard/skills?edit=" + encodeURIComponent(file) + "&source=user");
      if (file && existsSync(join(REPO_SKILLS_DIR, file))) return res.redirect("/dashboard/skills?edit=" + encodeURIComponent(file) + "&source=repo");
      return res.redirect("/dashboard/skills");
    }
    if (editParam === "writing-rules") {
      const result = await db.execute({
        sql: "SELECT content FROM crow_context WHERE section_key = 'writing_style' AND device_id IS NULL AND project_id IS NULL",
        args: [],
      });
      const currentContent = result.rows[0]?.content || "";
      const editForm = `
        <form method="POST">
          <input type="hidden" name="action" value="save-writing-rules">
          ${formField(t("skills.writingRules", lang), "content", { type: "textarea", value: currentContent, rows: 20, required: true })}
          <div style="display:flex;gap:0.5rem;margin-top:1rem">
            <button type="submit" class="btn btn-primary">${t("skills.save", lang)}</button>
            <a href="/dashboard/skills" class="btn btn-secondary">${t("skills.cancel", lang)}</a>
          </div>
        </form>`;
      const editContent = section(t("skills.writingRules", lang), editForm);
      return layout({ title: t("skills.editWritingRules", lang), content: editContent });
    }

    // Handle crow context section edit view. Only for a bare "context-<key>":
    // a skill FILE named context-*.md (the built-in context-management.md)
    // carries ".md" and a source, and opens in the skill viewer below.
    const editSource = one(query.source); // "user" or "repo"
    if (editParam && editParam.startsWith("context-") && !editParam.endsWith(".md") && !editSource) {
      const sectionKey = editParam.slice("context-".length);
      const EDITABLE_SECTIONS = [
        "identity", "memory_protocol", "research_protocol",
        "session_protocol", "transparency_rules", "key_principles",
        "writing_style",
      ];
      if (!EDITABLE_SECTIONS.includes(sectionKey)) {
        res.redirect("/dashboard/skills");
        return;
      }
      const result = await db.execute({
        sql: "SELECT section_title, content FROM crow_context WHERE section_key = ? AND device_id IS NULL AND project_id IS NULL",
        args: [sectionKey],
      });
      const row = result.rows[0];
      if (!row) {
        res.redirect("/dashboard/skills");
        return;
      }
      const editForm = `
        <form method="POST">
          <input type="hidden" name="action" value="save-context-section">
          <input type="hidden" name="sectionKey" value="${escapeHtml(sectionKey)}">
          ${formField(row.section_title || sectionKey, "content", { type: "textarea", value: row.content || "", rows: 20, required: true })}
          <div style="display:flex;gap:0.5rem;margin-top:1rem">
            <button type="submit" class="btn btn-primary">${t("skills.save", lang)}</button>
            <a href="/dashboard/skills" class="btn btn-secondary">${t("skills.cancel", lang)}</a>
          </div>
        </form>`;
      const editContent = section(row.section_title || sectionKey, editForm);
      return layout({ title: `${t("skills.editPrefix", lang)} ${row.section_title || sectionKey}`, content: editContent });
    }

    // Handle skill file edit view
    const editFile = editParam;
    if (editFile) {
      const safeName = existingSkillName(editFile);
      const isUserSkill = editSource === "user";
      const filePath = !safeName ? null : isUserSkill
        ? join(userSkillsDir(), safeName)
        : join(REPO_SKILLS_DIR, safeName);
      const content = filePath ? readSkillContent(filePath) : null;
      const isLink = !!filePath && isUserSkill && !!lstatOrNull(filePath)?.isSymbolicLink();

      if (content === null && !isLink) {
        res.redirect("/dashboard/skills");
        return;
      }
      const readOnly = !isUserSkill;
      const sourceLabel = isUserSkill ? t("skills.userSkillEditable", lang) : t("skills.builtInReadOnly", lang);

      let editForm;
      if (isLink) {
        // A linked skill (audit A14): saving would write into the link's
        // target. Show it read-only and offer a copy of the user's own.
        editForm = `
          <div class="skills-notice" role="status" style="margin-bottom:1rem;padding:0.75rem 1rem;border:1px solid var(--crow-border);border-radius:8px;background:var(--crow-bg-elevated)">${escapeHtml(t(content === null ? "skills.linkBrokenNotice" : "skills.linkNotice", lang))}</div>
          ${content === null ? "" : `<pre style="background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:8px;padding:1rem;overflow-x:auto;font-size:0.85rem;line-height:1.6;max-height:600px;overflow-y:auto;white-space:pre-wrap;word-wrap:break-word">${escapeHtml(content)}</pre>`}
          <div style="display:flex;gap:0.5rem;margin-top:1rem;flex-wrap:wrap">
            ${content === null ? "" : `<form method="POST">
              <input type="hidden" name="action" value="copy-link">
              <input type="hidden" name="filename" value="${escapeHtml(safeName)}">
              <button type="submit" class="btn btn-primary">${t("skills.makeOwnCopy", lang)}</button>
            </form>`}
            <a href="/dashboard/skills" class="btn btn-secondary">${t("skills.back", lang)}</a>
            <form method="POST" style="margin-left:auto" onsubmit="return confirm('${tJs("skills.deleteConfirm", lang)}')">
              <input type="hidden" name="action" value="delete">
              <input type="hidden" name="filename" value="${escapeHtml(safeName)}">
              <button type="submit" class="btn btn-sm btn-danger">${t("skills.delete", lang)}</button>
            </form>
          </div>`;
      } else if (readOnly) {
        // Read-only view for repo skills with "Override" button
        editForm = `
          <div style="margin-bottom:1rem">
            ${badge(sourceLabel, "draft")}
          </div>
          <pre style="background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:8px;padding:1rem;overflow-x:auto;font-size:0.85rem;line-height:1.6;max-height:600px;overflow-y:auto;white-space:pre-wrap;word-wrap:break-word">${escapeHtml(content)}</pre>
          <div style="display:flex;gap:0.5rem;margin-top:1rem">
            <form method="POST">
              <input type="hidden" name="action" value="override">
              <input type="hidden" name="filename" value="${escapeHtml(safeName)}">
              <button type="submit" class="btn btn-primary" onclick="return confirm('${tJs("skills.overrideConfirm", lang)}')">${t("skills.overrideButton", lang)}</button>
            </form>
            <a href="/dashboard/skills" class="btn btn-secondary">${t("skills.back", lang)}</a>
          </div>`;
      } else {
        // Editable form for user skills
        editForm = `
          <div style="margin-bottom:1rem">
            ${badge(sourceLabel, "published")}
          </div>
          <div style="display:flex;gap:0.5rem;align-items:flex-end;flex-wrap:wrap">
            <form method="POST" style="flex:1 1 100%">
              <input type="hidden" name="action" value="save">
              <input type="hidden" name="filename" value="${escapeHtml(safeName)}">
              ${formField(t("skills.contentLabel", lang), "content", { type: "textarea", value: content, rows: 20, required: true })}
              <div style="display:flex;gap:0.5rem;margin-top:1rem">
                <button type="submit" class="btn btn-primary">${t("skills.save", lang)}</button>
                <a href="/dashboard/skills" class="btn btn-secondary">${t("skills.cancel", lang)}</a>
              </div>
            </form>
            <form method="POST" style="margin-left:auto" onsubmit="return confirm('${tJs("skills.deleteUserSkillConfirm", lang)}')">
              <input type="hidden" name="action" value="delete">
              <input type="hidden" name="filename" value="${escapeHtml(safeName)}">
              <button type="submit" class="btn btn-sm btn-danger">${t("skills.delete", lang)}</button>
            </form>
          </div>`;
      }

      const editContent = section(safeName, editForm);
      return layout({ title: `${t("skills.skillPrefix", lang)} ${safeName}`, content: editContent });
    }

    // --- Main skills list ---
    // One row per skill from the catalog: where it comes from (built-in, an
    // extension, yours) and its sync status. Rows with no file (removed, or
    // shipped but not installed yet) get their actions in the redesigned page.
    const crowHome = resolveCrowHome();
    const catalog = classifySkills({
      crowHome, appBundles: APP_BUNDLES_DIR, repoDir: REPO_SKILLS_DIR, lang,
      kitSkills: await kitSkills(), kitInstalled: !!installedKitDir(crowHome),
    }).filter((r) => r.hasFile);
    const langAttr = (l) => (l !== lang ? ` lang="${l}"` : "");
    const chip = (text, kind = "") => `<span class="sk-chip${kind ? " sk-chip-" + kind : ""}">${escapeHtml(text)}</span>`;

    const rows = catalog.map((r) => {
      const ext = r.bundleName || r.bundle || "";
      const chips = [];
      if (r.source === "builtin") chips.push(chip(t("skills.builtInBadge", lang)));
      else if (r.source === "ext") {
        chips.push(chip(fill(t("skills.fromExt", lang), { ext }), "ext"));
        if (r.linked) chips.push(chip(t("skills.linked", lang)));
      } else chips.push(chip(r.basedOn ? fill(t("skills.copyOf", lang), { ext }) : t("skills.yoursBadge", lang), "yours"));
      if (r.replacesBuiltin) chips.push(chip(t("skills.replacesBuiltin", lang)));
      if (r.experimental) chips.push(chip(t("skills.experimental", lang)));
      const st = STATUS[r.status];
      if (st) chips.push(`<span class="sk-st sk-st-${st[1]}">${escapeHtml(t(st[0], lang))}</span>`);

      const editable = r.source !== "builtin";
      const source = editable ? "user" : "repo";
      const viewBtn = `<a href="/dashboard/skills?edit=${encodeURIComponent(r.file)}&source=${source}" class="btn btn-sm btn-secondary">${editable ? t("skills.edit", lang) : t("skills.view", lang)}</a>`;
      const deleteBtn = editable
        ? ` <form method="POST" style="display:inline;margin-left:0.25rem" onsubmit="return confirm('${tJs("skills.deleteConfirm", lang)}')"><input type="hidden" name="action" value="delete"><input type="hidden" name="filename" value="${escapeHtml(r.file)}"><button class="btn btn-sm btn-danger" type="submit">${t("skills.delete", lang)}</button></form>`
        : "";
      const purpose = r.description ? `<div class="sk-purpose"${langAttr(r.descriptionLang)}>${escapeHtml(r.description)}</div>` : "";

      return [
        `<span class="sk-name" data-skill="${escapeHtml(r.name)}" data-source="${r.source}"><span class="sk-title"${langAttr(r.titleLang)}>${escapeHtml(r.title)}</span></span>${purpose}`,
        `<span class="mono" style="font-size:0.8rem">${escapeHtml(r.name)}</span>`,
        `<span class="sk-chips">${chips.join("")}</span>`,
        `${viewBtn}${deleteBtn}`,
      ];
    });

    const skillsTable = catalog.length === 0
      ? `<div class="empty-state"><h3>${t("skills.noSkillsFound", lang)}</h3><p>${t("skills.skillsDirectory", lang)}</p></div>`
      : SKILLS_TABLE_CSS + dataTable([t("skills.tableName", lang), t("skills.tableFile", lang), t("skills.tableSource", lang), t("skills.tableActions", lang)], rows, { stack: true });

    // Create form. After a refused create (422) it holds what was typed, the
    // error sits inside it, and the field to fix has autofocus, so the
    // re-rendered page lands on the form (audit A18; on a phone it is far
    // down the page).
    const cs = createState;
    const typedVal = (k) => (cs ? cs.typed[k] : "");
    let createError = "";
    if (cs) {
      const msg = cs.code === "exists"
        ? fill(t("skills.errorExistsNamed", lang), { name: cs.typed.filename.trim() })
        : cs.code === "shipped"
          ? fill(t("skills.errorShippedName", lang), { ext: cs.shippedBy })
          : t(NOTICE_CODES[cs.code], lang);
      const open = cs.existing
        ? ` <a href="/dashboard/skills?edit=${encodeURIComponent(cs.existing.file)}&amp;source=${cs.existing.source}">${escapeHtml(t("skills.openExisting", lang))}</a>`
        : "";
      createError = `<div class="skills-notice" role="alert" style="margin-bottom:1rem;padding:0.75rem 1rem;border:1px solid var(--crow-border);border-left:3px solid var(--crow-error);border-radius:8px;background:var(--crow-bg-elevated)">${escapeHtml(msg)}${open}</div>`;
    }
    const focusField = cs ? (cs.code === "empty" ? "content" : "filename") : null;
    const withFocus = (html, name) => (focusField === name ? html.replace(`id="field-${name}"`, `id="field-${name}" autofocus`) : html);
    const createForm = `<form method="POST" id="skill-create">
      <input type="hidden" name="action" value="create">
      ${createError}
      ${withFocus(formField(t("skills.filenameLabel", lang), "filename", { placeholder: t("skills.filenamePlaceholder", lang), required: true, value: typedVal("filename") }), "filename")}
      ${formField(t("skills.purposeLabel", lang), "purpose", { value: typedVal("purpose") })}
      ${withFocus(formField(t("skills.contentLabel", lang), "content", { type: "textarea", required: true, placeholder: t("skills.contentPlaceholder", lang), rows: 10, value: typedVal("content") }), "content")}
      <button type="submit" class="btn btn-primary">${t("skills.createSkill", lang)}</button>
    </form>`;

    // --- Writing Rules section ---
    const writingStyleResult = await db.execute({
      sql: "SELECT content FROM crow_context WHERE section_key = 'writing_style' AND device_id IS NULL AND project_id IS NULL",
      args: [],
    });
    const writingStyleContent = writingStyleResult.rows[0]?.content || "";
    // The seeded template (headings + "(Add …)" placeholders) is not a rule (A26).
    const isTemplateContent = isWritingRulesTemplate(writingStyleContent);

    let writingRulesBody;
    if (isTemplateContent) {
      writingRulesBody = `
        <p style="color:var(--crow-text-secondary);font-style:italic;margin-bottom:1rem">${t("skills.writingRulesHint", lang)}</p>
        <a href="/dashboard/skills?edit=writing-rules" class="btn btn-sm btn-primary">${t("skills.setUpWritingRules", lang)}</a>`;
    } else {
      writingRulesBody = `
        <pre style="background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:8px;padding:1rem;overflow-x:auto;font-size:0.85rem;line-height:1.6;max-height:300px;overflow-y:auto;white-space:pre-wrap;word-wrap:break-word">${escapeHtml(writingStyleContent)}</pre>
        <div style="margin-top:0.75rem">
          <a href="/dashboard/skills?edit=writing-rules" class="btn btn-sm btn-secondary">${t("skills.edit", lang)}</a>
        </div>`;
    }

    const writingRulesSection = `<div class="card" style="margin-bottom:1.5rem;border-left:3px solid #4caf50">
      <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;padding-bottom:0.5rem;border-bottom:1px solid var(--crow-border)">
        <h3 style="font-family:var(--crow-body-font);font-size:1.1rem;margin:0">${t("skills.writingRules", lang)}</h3>
        ${badge(t("skills.alwaysActive", lang), "connected")}
      </div>
      ${writingRulesBody}
    </div>`;

    // --- Crow Context section ---
    const contextResult = await db.execute({
      sql: "SELECT section_key, section_title, content FROM crow_context WHERE device_id IS NULL AND project_id IS NULL ORDER BY sort_order ASC",
      args: [],
    });
    const contextRows = contextResult.rows || [];

    const READ_ONLY_SECTIONS = ["skills_reference"];
    const CORE_SECTIONS = ["memory_protocol", "session_protocol", "transparency_rules"];

    const contextCards = contextRows
      .filter((row) => row.section_key !== "writing_style")
      .map((row) => {
        const content = row.content || "";
        const preview = content.length > 100 ? escapeHtml(content.slice(0, 100)) + "..." : escapeHtml(content);
        const isReadOnly = READ_ONLY_SECTIONS.includes(row.section_key);
        const isCore = CORE_SECTIONS.includes(row.section_key);

        let badgeHtml = "";
        if (isReadOnly) {
          badgeHtml = ` ${badge(t("skills.autoGenerated", lang), "draft")}`;
        } else if (isCore) {
          badgeHtml = ` ${badge(t("skills.core", lang), "warning")}`;
        }

        const editBtn = isReadOnly
          ? ""
          : `<a href="/dashboard/skills?edit=context-${encodeURIComponent(row.section_key)}" class="btn btn-sm btn-secondary" style="margin-top:0.5rem">${t("skills.edit", lang)}</a>`;

        return `<details style="margin-bottom:0.5rem;border:1px solid var(--crow-border);border-radius:6px;overflow:hidden">
          <summary style="padding:0.75rem 1rem;cursor:pointer;background:var(--crow-bg-elevated);display:flex;align-items:center;gap:0.5rem;font-weight:500">
            ${escapeHtml(row.section_title || row.section_key)}${badgeHtml}
          </summary>
          <div style="padding:0.75rem 1rem;font-size:0.85rem">
            <pre style="background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:6px;padding:0.75rem;overflow-x:auto;font-size:0.82rem;line-height:1.5;max-height:250px;overflow-y:auto;white-space:pre-wrap;word-wrap:break-word;margin:0">${escapeHtml(content)}</pre>
            ${editBtn}
          </div>
        </details>`;
      })
      .join("");

    const crowContextBody = contextCards || `<p style="color:var(--crow-text-secondary)">${t("skills.noContextSections", lang)}</p>`;
    const crowContextSection = `<div class="card" style="margin-bottom:1.5rem">
      <details>
        <summary style="cursor:pointer">
          <h3 style="font-family:var(--crow-body-font);font-size:1.1rem;display:inline">${t("skills.crowContext", lang)}</h3>
          <span style="color:var(--crow-text-muted);font-size:0.85rem;margin-left:0.5rem">${escapeHtml(fill(t("skills.sectionsCount", lang), { n: contextRows.filter((r) => r.section_key !== "writing_style").length }))}</span>
        </summary>
        <div style="margin-top:1rem">
          ${crowContextBody}
        </div>
      </details>
    </div>`;

    // Marketplace link
    const marketplaceLink = `<div style="background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:8px;padding:1rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
      <span style="font-weight:600;color:var(--crow-text)">${t("skills.wantMoreSkills", lang)}</span>
      <span style="color:var(--crow-text-secondary);flex:1">${t("skills.browseSkillBundles", lang)}</span>
      <a href="/dashboard/extensions" class="btn btn-sm btn-primary">${t("skills.extensionsLink", lang)}</a>
    </div>`;

    // One notice for a refused create (audit A10/A11); unknown codes show nothing.
    // A create also names the file it made (the slug can differ from the input).
    const noticeKey = NOTICE_CODES[one(query.error)];
    const createdName = existingSkillName(one(query.created));
    const created = createdName && lstatOrNull(join(userSkillsDir(), createdName)) ? createdName : null;
    const noticeBox = (role, accent, text) => `<div class="skills-notice" role="${role}" style="margin-bottom:1.5rem;padding:0.75rem 1rem;border:1px solid var(--crow-border);border-left:3px solid ${accent};border-radius:8px;background:var(--crow-bg-elevated)">${escapeHtml(text)}</div>`;
    const notice = noticeKey
      ? noticeBox("alert", "var(--crow-error, #c62828)", t(noticeKey, lang))
      : created ? noticeBox("status", "var(--crow-success, #2e7d32)", fill(t("skills.created", lang), { name: created })) : "";

    const content = `
      ${notice}
      ${writingRulesSection}
      ${crowContextSection}
      ${marketplaceLink}
      ${section(t("skills.allSkills", lang), skillsTable, { delay: 150 })}
      ${section(t("skills.createNewSkill", lang), createForm, { delay: 200 })}
    `;

    return layout({ title: t("skills.pageTitle", lang), content });
  },
};
