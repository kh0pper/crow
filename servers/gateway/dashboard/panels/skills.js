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
import { existsSync, readFileSync, unlinkSync, readdirSync, lstatSync, statSync, chmodSync } from "fs";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { resolveCrowHome } from "../../../shared/crow-home.js";
import { atomicWrite, bundleShippingSkill, recordRemovedLink } from "../../bundle-skill-sync.js";
import { normalizeSkillName } from "../../../../scripts/pi-bots/skill_proposals.mjs";
import { invalidateContextCache } from "../../../memory/crow-context.js";
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

/**
 * A NEW skill's file name from the create form: lowercase, whitespace runs →
 * "-", anything outside [a-z0-9_-] dropped, leading/trailing "-"/"_" trimmed,
 * then the bot resolver's own normalizeSkillName must accept it unchanged —
 * so a bot can always load what the panel made ("My Test Skill" →
 * my-test-skill.md). null when nothing valid is left.
 */
function newSkillName(raw) {
  if (typeof raw !== "string") return null;
  let s = basename(raw).trim().toLowerCase();
  if (s.endsWith(".md")) s = s.slice(0, -3);
  s = s.replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").replace(/^[-_]+|[-_]+$/g, "");
  if (!s || normalizeSkillName(s) !== s) return null;
  return s + ".md";
}

function lstatOrNull(p) {
  try { return lstatSync(p); } catch { return null; }
}

/** LF line endings (browsers submit textareas with CRLF). */
const toLf = (text) => text.replace(/\r\n/g, "\n");

/** Write a skill file (tmp + rename), keeping an existing regular file's mode. */
function writeSkill(filePath, text) {
  const st = lstatOrNull(filePath);
  atomicWrite(filePath, toLf(text));
  if (st && st.isFile()) {
    try { chmodSync(filePath, st.mode & 0o777); } catch { /* best effort */ }
  }
}

const NOTICE_CODES = {
  "invalid-name": "skills.errorInvalidName",
  exists: "skills.errorExists",
  empty: "skills.errorEmpty",
  "not-found": "skills.errorNotFound",
  "link-unreadable": "skills.errorLinkUnreadable",
  "record-unreadable": "skills.errorRecordUnreadable",
};

function listSkillFiles(dir) {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => SKILL_FILE_RE.test(f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * A skill's text, or null. Only a regular file (after following a link) of at
 * most MAX_SKILL_BYTES is read: a link to a directory, a missing target, a
 * FIFO or a device yields null instead of an error or a blocked event loop.
 */
function readSkillContent(filePath) {
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size > MAX_SKILL_BYTES) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function parseSkillFrontmatter(content) {
  if (!content) return { title: "", description: "" };
  // Extract title from first # heading or filename
  const titleMatch = content.match(/^#\s+(.+?)(?:\s*—.*)?$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";
  // Extract description from ## Description section or first paragraph after title
  const descMatch = content.match(/^##\s+Description\s*\n+([\s\S]*?)(?=\n##|\n$)/m);
  const description = descMatch ? descMatch[1].trim().split("\n")[0] : "";
  return { title, description };
}

export default {
  id: "skills",
  name: "Skills",
  icon: "skills",
  route: "/dashboard/skills",
  navOrder: 35,
  category: "tools",

  async handler(req, res, { db, layout, lang }) {
    // Handle POST actions
    if (req.method === "POST") {
      const body = req.body || {};
      // A repeated field arrives as an array (urlencoded, extended:false) —
      // e.g. the old nested Save/Delete forms posted action=save&action=delete.
      // Refuse it outright rather than fall through to a 200 list render.
      for (const k of ["action", "filename", "content", "sectionKey"]) {
        if (body[k] !== undefined && typeof body[k] !== "string") {
          // text/html so Turbo shows it (a text/plain 4xx is dropped silently).
          res.status(400).type("html").send(`<p>${escapeHtml(t("skills.errorBadRequest", lang))}</p>`);
          return;
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
        const safeName = newSkillName(body.filename);
        const content = one(body.content);
        if (!safeName) return back("invalid-name");
        if (!content || !content.trim()) return back("empty");
        const filePath = join(userSkillsDir(), safeName);
        // Exists in either dir: shadowing a built-in goes through Override (A12).
        if (lstatOrNull(filePath) || existsSync(join(REPO_SKILLS_DIR, safeName))) return back("exists");
        writeSkill(filePath, content);
        res.redirectAfterPost("/dashboard/skills?created=" + encodeURIComponent(safeName));
        return;
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
    const query = req.query || {};
    const editParam = one(query.edit); // a repeated ?edit= reads as absent (was a 500)
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
    const repoSkills = listSkillFiles(REPO_SKILLS_DIR);
    const userSkills = listSkillFiles(userSkillsDir());

    // Build merged list: user skills override repo skills
    const userSkillSet = new Set(userSkills);
    const allSkillNames = [...new Set([...userSkills, ...repoSkills])].sort();

    // Skills table
    const rows = allSkillNames.map((filename) => {
      const isOverridden = userSkillSet.has(filename) && repoSkills.includes(filename);
      const isUserOnly = userSkillSet.has(filename) && !repoSkills.includes(filename);
      const isBuiltIn = !userSkillSet.has(filename);

      const source = isUserOnly ? "user" : isOverridden ? "user" : "repo";
      const filePath = source === "user"
        ? join(userSkillsDir(), filename)
        : join(REPO_SKILLS_DIR, filename);
      const content = readSkillContent(filePath);
      const { title } = parseSkillFrontmatter(content);

      const displayName = title || filename.replace(/\.md$/, "").replace(/-/g, " ");
      const name = filename.replace(/\.md$/, "");

      let statusBadge;
      if (isOverridden) {
        statusBadge = `${badge(t("skills.overridden", lang), "connected")} ${badge(t("skills.builtInBadge", lang), "draft")}`;
      } else if (isUserOnly) {
        statusBadge = badge(t("skills.customBadge", lang), "published");
      } else {
        statusBadge = badge(t("skills.builtInBadge", lang), "draft");
      }

      const viewBtn = `<a href="/dashboard/skills?edit=${encodeURIComponent(filename)}&source=${source}" class="btn btn-sm btn-secondary">${isBuiltIn ? t("skills.view", lang) : t("skills.edit", lang)}</a>`;
      const deleteBtn = !isBuiltIn
        ? ` <form method="POST" style="display:inline;margin-left:0.25rem" onsubmit="return confirm('${tJs("skills.deleteConfirm", lang)}')"><input type="hidden" name="action" value="delete"><input type="hidden" name="filename" value="${escapeHtml(filename)}"><button class="btn btn-sm btn-danger" type="submit">${t("skills.delete", lang)}</button></form>`
        : "";

      return [
        escapeHtml(displayName),
        `<span class="mono" style="font-size:0.8rem">${escapeHtml(name)}</span>`,
        statusBadge,
        `${viewBtn}${deleteBtn}`,
      ];
    });

    const skillsTable = allSkillNames.length === 0
      ? `<div class="empty-state"><h3>${t("skills.noSkillsFound", lang)}</h3><p>${t("skills.skillsDirectory", lang)}</p></div>`
      : dataTable([t("skills.tableName", lang), t("skills.tableFile", lang), t("skills.tableSource", lang), t("skills.tableActions", lang)], rows, { stack: true });

    // Create form
    const createForm = `<form method="POST">
      <input type="hidden" name="action" value="create">
      ${formField(t("skills.filenameLabel", lang), "filename", { placeholder: t("skills.filenamePlaceholder", lang), required: true })}
      ${formField(t("skills.contentLabel", lang), "content", { type: "textarea", required: true, placeholder: t("skills.contentPlaceholder", lang), rows: 10 })}
      <button type="submit" class="btn btn-primary">${t("skills.createSkill", lang)}</button>
    </form>`;

    // --- Writing Rules section ---
    const writingStyleResult = await db.execute({
      sql: "SELECT content FROM crow_context WHERE section_key = 'writing_style' AND device_id IS NULL AND project_id IS NULL",
      args: [],
    });
    const writingStyleContent = writingStyleResult.rows[0]?.content || "";
    const isTemplateContent = !writingStyleContent || writingStyleContent.trim().length < 20;

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
    const created = existingSkillName(one(query.created));
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
