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

import { escapeHtml, section, formField, badge } from "../shared/components.js";
import { t, tJs, fill } from "../shared/i18n.js";
import { existsSync, readFileSync, unlinkSync, readdirSync, lstatSync, openSync, fstatSync, closeSync, constants as fsConstants } from "fs";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { resolveCrowHome } from "../../../shared/crow-home.js";
import { atomicWrite, bundleShippingSkill, recordRemovedLink, installShippedSkill, skillHash, manifestSkillPaths } from "../../bundle-skill-sync.js";
import { normalizeSkillName } from "../../../../scripts/pi-bots/skill_proposals.mjs";
import { invalidateContextCache } from "../../../memory/crow-context.js";
import { classifySkills, parseSkillMeta, anyBundleShipping, extensionCopyOf, attentionItems } from "../../skills-catalog.js";
import { readSkillState, setSkillOff, skillStateName, ackSkill } from "../../../shared/skill-state.js";
import { lineDiff } from "../../../shared/line-diff.js";
import { renderSkillsPage, fold } from "./skills/html.js";
import { SKILLS_CSS } from "./skills/css.js";
import { skillsClientJs } from "./skills/client.js";
import { EXEMPT_FROM_OFF } from "../../../../scripts/pi-bots/skill_resolver.mjs";
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
  "extension-skill": "skills.errorExtensionSkill",
  "state-unreadable": "skills.errorStateUnreadable",
  changed: "skills.errorChanged",
  "not-shipped": "skills.errorNotShipped",
  "backup-dir": "skills.errorBackupDir",
};

/** Toasts after an action (?done=<code>). */
const DONE_TOASTS = { updated: "skills.toast.updated", restored: "skills.toast.restored", kept: "skills.toast.kept", "kept-mine": "skills.toast.keptMine" };

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


/** A string for a single-quoted JS literal inside an HTML attribute. */
const jsAttr = (str) => escapeHtml(String(str).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, " "));

/**
 * The delete confirm for a user skill: a copy of an extension says its
 * extension's version won't come back by itself (review I5); every confirm
 * names how many bots lose the skill.
 */
function deleteConfirmText(row, n, lang) {
  const head = row && row.basedOn
    ? fill(t("skills.deleteCopyConfirm", lang), { ext: row.bundleName || row.basedOn })
    : t(row && row.replacesBuiltin ? "skills.deleteUserSkillConfirm" : "skills.deleteConfirm", lang);
  const tail = n === 0 ? "" : n === 1 ? t("skills.deleteUsed1", lang) : fill(t("skills.deleteUsedN", lang), { n });
  return tail ? `${head} ${tail}` : head;
}

/** Which bots use each skill (lazy: it loads bot-world.mjs). Empty on any failure. */
async function usageMap(db, crowHome) {
  try {
    const { skillUsage, loadBotRows } = await import("../../skills-used-by.js");
    return skillUsage({ crowHome, botRows: await loadBotRows(db) });
  } catch { return new Map(); }
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
    // Set by a refused create: the list renders again with the form filled in.
    let createState = null;
    if (req.method === "POST") {
      const body = req.body || {};
      // A repeated field arrives as an array (urlencoded, extended:false) —
      // e.g. the old nested Save/Delete forms posted action=save&action=delete.
      // Refuse it outright rather than fall through to a 200 list render.
      for (const k of ["action", "filename", "content", "sectionKey", "purpose", "skill", "customize", "srcSha"]) {
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
        // Save guard (option C, review I8): an unedited extension copy is
        // written only from the Customize editor (customize=1), so a stale or
        // forged form can never silently stop its updates. Same rule as the
        // "From <ext>" badge (isExtensionCopy).
        if (one(body.customize) !== "1" && extensionCopyOf({ crowHome: resolveCrowHome(), appBundles: APP_BUNDLES_DIR, file: safeName })) {
          res.redirectAfterPost(editUrl(safeName));
          return;
        }
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
            // An extension's skill is switched off, never deleted (owner
            // decision, 10-16): deleting an unedited copy would just be reinstalled or
            // tombstoned behind the owner's back.
            if (extensionCopyOf({ crowHome: resolveCrowHome(), appBundles: APP_BUNDLES_DIR, file: safeName })) return back("extension-skill");
            unlinkSync(filePath);
          }
        }
        res.redirectAfterPost("/dashboard/skills");
        return;
      }

      if (action === "apply-update" || action === "restore-shipped") {
        // Apply update / Restore original / Restore: the extension's shipped
        // copy, on this explicit click, in every sync mode (owner decision Q2). The
        // expected actions make a race since the page rendered a no-op.
        const file = existingSkillName(one(body.skill) ?? "");
        if (!file) return back("invalid-name");
        const expect = action === "apply-update" ? ["refresh", "install"] : ["kept-edited", "kept-unverified", "skip-deleted"];
        // The shipped version the page showed: required, so a checkout that
        // moved under the page never writes a version nobody reviewed.
        const posted = one(body.srcSha);
        const srcSha = posted && /^[0-9a-f]{64}$/.test(posted) ? posted : null;
        const name = file.replace(/\.md$/, "");
        const done = `/dashboard/skills?skill=${encodeURIComponent(name)}&done=${action === "apply-update" ? "updated" : "restored"}#skill-${encodeURIComponent(name)}`;
        if (!srcSha) return back("changed");
        const r = installShippedSkill({ crowHome: resolveCrowHome(), appBundles: APP_BUNDLES_DIR, skill: file, expect, srcSha });
        if (!r.ok) {
          // A second click after it worked: that version is already in place.
          if (r.error === "changed" && (r.action === "same" || r.action === "adopt") && r.srcSha === srcSha) { res.redirectAfterPost(done); return; }
          return back(["record-unreadable", "not-shipped", "backup-dir"].includes(r.error) ? r.error : "changed");
        }
        res.redirectAfterPost(done);
        return;
      }

      if (action === "ack") {
        // Keep mine (per shipped version) / Keep (a skill no longer shipped).
        const file = existingSkillName(one(body.skill) ?? "");
        if (!file) return back("invalid-name");
        const sha = one(body.srcSha);
        const r = ackSkill(resolveCrowHome(), file, sha && /^[0-9a-f]{64}$/.test(sha) ? sha : null);
        if (!r.ok) return back(r.error === "unreadable" ? "state-unreadable" : "invalid-name");
        const name = file.replace(/\.md$/, "");
        res.redirectAfterPost(`/dashboard/skills?skill=${encodeURIComponent(name)}&done=${sha ? "kept-mine" : "kept"}#skill-${encodeURIComponent(name)}`);
        return;
      }

      if (action === "set-off" || action === "set-on") {
        // The on/off switch. Per instance; bots pick it up in new conversations.
        const name = skillStateName(one(body.skill) ?? "");
        if (!name || EXEMPT_FROM_OFF.includes(name)) return back("invalid-name");
        const r = setSkillOff(resolveCrowHome(), name, action === "set-off");
        if (!r.ok) return back(r.error === "unreadable" ? "state-unreadable" : "invalid-name");
        res.redirectAfterPost(`/dashboard/skills?toggled=${encodeURIComponent(name)}&to=${action === "set-off" ? "off" : "on"}`);
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
        res.redirectAfterPost("/dashboard/skills?view=behavior");
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
          res.redirectAfterPost("/dashboard/skills?view=behavior");
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
        res.redirectAfterPost("/dashboard/skills?view=behavior");
        return;
      }
    }

    // Handle writing rules edit view
    const query = createState ? {} : (req.query || {});
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
            <a href="/dashboard/skills?view=behavior" class="btn btn-secondary">${t("skills.cancel", lang)}</a>
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
            <a href="/dashboard/skills?view=behavior" class="btn btn-secondary">${t("skills.cancel", lang)}</a>
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
      const crowHomeNow = resolveCrowHome();
      // An unedited extension copy is read-only until the owner picks
      // Customize… (the same rule as its "From <ext>" badge and the Save guard).
      const extCopy = isUserSkill && !isLink ? extensionCopyOf({ crowHome: crowHomeNow, appBundles: APP_BUNDLES_DIR, file: safeName }) : null;
      const customizing = !!extCopy && one(query.customize) === "1";
      const linkShipped = isLink && !!bundleShippingSkill({ crowHome: crowHomeNow, appBundles: APP_BUNDLES_DIR, skill: safeName });
      const noticeDiv = (text) => `<div class="skills-notice" role="status" style="margin-bottom:1rem;padding:0.75rem 1rem;border:1px solid var(--crow-border);border-radius:8px;background:var(--crow-bg-elevated)">${escapeHtml(text)}</div>`;
      let deleteText = t("skills.deleteConfirm", lang);
      if (isUserSkill && !extCopy && !isLink) {
        const row = classifySkills({ crowHome: crowHomeNow, appBundles: APP_BUNDLES_DIR, repoDir: REPO_SKILLS_DIR, lang }).find((r) => r.file === safeName && !r.shadow);
        const n = ((await usageMap(db, crowHomeNow)).get(safeName.replace(/\.md$/, "")) || []).length;
        deleteText = deleteConfirmText(row, n, lang);
      }

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
            ${linkShipped ? "" : `<form method="POST" style="margin-left:auto" onsubmit="return confirm('${tJs("skills.deleteConfirm", lang)}')">
              <input type="hidden" name="action" value="delete">
              <input type="hidden" name="filename" value="${escapeHtml(safeName)}">
              <button type="submit" class="btn btn-sm btn-danger">${t("skills.delete", lang)}</button>
            </form>`}
          </div>`;
      } else if (extCopy && !customizing) {
        // An extension's skill: read-only, switch it off rather than delete it.
        const ext = extCopy.bundleName;
        editForm = `
          ${noticeDiv(fill(t("skills.extCopyNotice", lang), { ext }))}
          <pre style="background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:8px;padding:1rem;overflow-x:auto;font-size:0.85rem;line-height:1.6;max-height:600px;overflow-y:auto;white-space:pre-wrap;word-wrap:break-word">${escapeHtml(content)}</pre>
          <div style="display:flex;gap:0.5rem;margin-top:1rem;flex-wrap:wrap;align-items:center">
            <a href="/dashboard/skills?edit=${encodeURIComponent(safeName)}&amp;source=user&amp;customize=1" class="btn btn-primary">${escapeHtml(t("skills.customize", lang))}</a>
            <span style="color:var(--crow-text-secondary);font-size:0.85rem">${escapeHtml(fill(t("skills.customizeWarn", lang), { ext }))}</span>
            <a href="/dashboard/skills" class="btn btn-secondary" style="margin-left:auto">${t("skills.back", lang)}</a>
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
          ${customizing ? noticeDiv(fill(t("skills.customizeWarn", lang), { ext: extCopy.bundleName })) : ""}
          <div style="display:flex;gap:0.5rem;align-items:flex-end;flex-wrap:wrap">
            <form method="POST" style="flex:1 1 100%">
              <input type="hidden" name="action" value="save">
              <input type="hidden" name="filename" value="${escapeHtml(safeName)}">
              ${customizing ? `<input type="hidden" name="customize" value="1">` : ""}
              ${formField(t("skills.contentLabel", lang), "content", { type: "textarea", value: content, rows: 20, required: true })}
              <div style="display:flex;gap:0.5rem;margin-top:1rem">
                <button type="submit" class="btn btn-primary">${t("skills.save", lang)}</button>
                <a href="/dashboard/skills" class="btn btn-secondary">${t("skills.cancel", lang)}</a>
              </div>
            </form>
            ${customizing ? "" : `<form method="POST" style="margin-left:auto" onsubmit="return confirm('${jsAttr(deleteText)}')">
              <input type="hidden" name="action" value="delete">
              <input type="hidden" name="filename" value="${escapeHtml(safeName)}">
              <button type="submit" class="btn btn-sm btn-danger">${t("skills.delete", lang)}</button>
            </form>`}
          </div>`;
      }

      const editContent = section(safeName, editForm);
      return layout({ title: `${t("skills.skillPrefix", lang)} ${safeName}`, content: editContent });
    }

    if (one(query.view) === "behavior") return layout({ title: t("skills.behaviorTitle", lang), content: await behaviorView(db, lang) });

    // --- Main skills list (option C) ---
    const crowHome = resolveCrowHome();
    const stateRead = readSkillState(crowHome);
    const offSet = new Set(stateRead.state.off);
    const allRows = classifySkills({
      crowHome, appBundles: APP_BUNDLES_DIR, repoDir: REPO_SKILLS_DIR, lang,
      kitSkills: await kitSkills(), kitInstalled: !!installedKitDir(crowHome), ack: stateRead.state.ack || {},
    });
    const usage = await usageMap(db, crowHome);
    const attention = attentionItems(allRows, usage, offSet);
    // Shown: every row with a file, a removed extension skill, and an update
    // not installed yet (each with its own action).
    const shown = allRows.filter((r) => r.hasFile || r.status === "removed" || r.status === "update");
    const q = (one(query.q) ?? "").trim().slice(0, 100);
    const qf = fold(q);
    const match = (r) => !qf || fold([r.name, r.title, r.description, r.bundleName, r.bundle, r.file].join(" ")).includes(qf);
    const rows = shown.filter(match);
    const listed = new Set(allRows.map((r) => r.name));
    const offMissing = [...offSet].filter((n) => !listed.has(n) && !EXEMPT_FROM_OFF.includes(n) && (!qf || fold(n).includes(qf))).sort();

    // The one selected skill (?skill=), its text and, with &compare=1, the diff
    // against what Restore / Apply would write.
    let selected = null;
    const skillParam = one(query.skill);
    if (skillParam !== null) {
      const base = normalizeSkillName(skillParam);
      const wantBuiltin = one(query.builtin) === "1";
      const r = base ? shown.find((x) => x.name === base && !!x.shadow === wantBuiltin) || shown.find((x) => x.name === base) : null;
      if (!r) return res.redirect("/dashboard/skills");
      const text = r.hasFile && r.path ? readSkillContent(r.path) : null;
      const shipped = shippedCopy(r);
      const dx = { text: text ?? (shipped ? shipped.text : null), shipped, version: shipped ? shipped.version : null, compare: one(query.compare) === "1", diff: null };
      if (dx.compare) {
        const builtinText = r.replacesBuiltin && r.source === "yours" ? readSkillContent(join(REPO_SKILLS_DIR, r.file)) : null;
        const target = shipped ? shipped.text : builtinText;
        if (target !== null && target !== undefined) {
          const d = lineDiff(text || "", target);
          d.fromLabel = t("skills.d.yourText", lang);
          d.toLabel = shipped ? fill(t("skills.d.extVersion", lang), { ext: r.bundleName || r.bundle }) : t("skills.d.builtinVersion", lang);
          dx.diff = d;
        }
      }
      selected = { name: r.name, shadow: !!r.shadow, source: r.source, dx };
      if (!rows.includes(r)) rows.push(r);
    }

    // Toast after a switch or an action; notices for errors and a create.
    const toggled = skillStateName(one(query.toggled) ?? "");
    const toggledTo = one(query.to);
    let toast = null;
    if (toggled && (toggledTo === "off" || toggledTo === "on")) {
      const tr = allRows.find((r) => r.name === toggled && !r.shadow);
      const name = tr ? tr.title : toggled;
      const n = (usage.get(toggled) || []).length;
      toast = toggledTo === "on"
        ? fill(t("skills.toastOn", lang), { name })
        : fill(t(n === 0 ? "skills.toastOff0" : n === 1 ? "skills.toastOff1" : "skills.toastOffN", lang), { name, n });
    } else if (DONE_TOASTS[one(query.done)] && !selected) toast = t(DONE_TOASTS[one(query.done)], lang);
    // After Apply / Restore / Keep the detail stays open with the result in it.
    if (selected && DONE_TOASTS[one(query.done)]) selected.dx.done = t(DONE_TOASTS[one(query.done)], lang);
    const noticeKey = NOTICE_CODES[one(query.error)];
    const createdName = existingSkillName(one(query.created));
    const created = createdName && lstatOrNull(join(userSkillsDir(), createdName)) ? createdName : null;
    const noticeBox = (role, kind, text) => `<div class="skills-notice sk-note sk-note-${kind}" role="${role}">${escapeHtml(text)}</div>`;
    const notice = noticeKey ? noticeBox("alert", "err", t(noticeKey, lang)) : created ? noticeBox("status", "plain", fill(t("skills.created", lang), { name: created })) : "";
    const stateBanner = stateRead.ok ? "" : noticeBox("alert", "err", t("skills.stateUnreadableBanner", lang));

    let cs = null;
    if (createState) {
      const message = createState.code === "exists"
        ? fill(t("skills.errorExistsNamed", lang), { name: createState.typed.filename.trim() })
        : createState.code === "shipped"
          ? fill(t("skills.errorShippedName", lang), { ext: createState.shippedBy })
          : t(NOTICE_CODES[createState.code], lang);
      cs = { ...createState, message };
    }

    const content = SKILLS_CSS + renderSkillsPage({
      lang, rows, off: offSet, usage, attention, offMissing, q, selected, toggled, toast, notice, stateBanner,
      createState: cs, createOpen: one(query.new) === "1", newName: one(query.name) ?? "",
      fileHint: (name) => { const n = newSkillName(name || ""); return n ? n.file : "…"; },
      deleteConfirm: (row, n) => deleteConfirmText(row, n, lang),
    }) + skillsClientJs();
    return layout({ title: t("skills.pageTitle", lang), content });
  },
};

/** The shipped copy of a skill an extension ships: {text, sha, version}, or null. */
function shippedCopy(r) {
  if (!r.bundle || r.source === "builtin") return null;
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(APP_BUNDLES_DIR, r.bundle, "manifest.json"), "utf8")); } catch { return null; }
  const p = manifestSkillPaths(manifest).find((x) => x.split("/").pop() === r.file);
  const text = p ? readSkillContent(join(APP_BUNDLES_DIR, r.bundle, p)) : null;
  if (text === null) return null;
  return { text, sha: skillHash(text), version: typeof manifest.version === "string" ? manifest.version : null };
}

/** "How Crow behaves": writing rules and the crow.md sections (moved off the skills list). */
async function behaviorView(db, lang) {
  const writingStyleResult = await db.execute({
    sql: "SELECT content FROM crow_context WHERE section_key = 'writing_style' AND device_id IS NULL AND project_id IS NULL",
    args: [],
  });
  const writingStyleContent = writingStyleResult.rows[0]?.content || "";
  // The seeded template (headings + "(Add …)" placeholders) is not a rule (A26).
  const isTemplateContent = isWritingRulesTemplate(writingStyleContent);
  const writingRulesBody = isTemplateContent
    ? `<p class="sk-muted" style="margin-bottom:1rem">${t("skills.writingRulesHint", lang)}</p>
        <a href="/dashboard/skills?edit=writing-rules" class="btn btn-primary">${t("skills.setUpWritingRules", lang)}</a>`
    : `<pre class="sk-pre">${escapeHtml(writingStyleContent)}</pre>
        <div style="margin-top:0.75rem"><a href="/dashboard/skills?edit=writing-rules" class="btn btn-secondary">${t("skills.edit", lang)}</a></div>`;
  const writingRulesSection = `<section class="sk-sec sk-card"><div class="sk-sec-h"><b>${t("skills.writingRules", lang)}</b>${isTemplateContent ? `<span class="sk-chip sk-chip-flag">${escapeHtml(t("skills.notSetUp", lang))}</span>` : badge(t("skills.alwaysActive", lang), "connected")}</div><div class="sk-card-body">${writingRulesBody}</div></section>`;

  const contextResult = await db.execute({
    sql: "SELECT section_key, section_title, content FROM crow_context WHERE device_id IS NULL AND project_id IS NULL ORDER BY sort_order ASC",
    args: [],
  });
  const contextRows = (contextResult.rows || []).filter((row) => row.section_key !== "writing_style");
  const READ_ONLY_SECTIONS = ["skills_reference"];
  const CORE_SECTIONS = ["memory_protocol", "session_protocol", "transparency_rules"];
  const contextCards = contextRows.map((row) => {
    const isReadOnly = READ_ONLY_SECTIONS.includes(row.section_key);
    const isCore = CORE_SECTIONS.includes(row.section_key);
    const chipHtml = isReadOnly ? ` <span class="sk-chip sk-chip-plain">${escapeHtml(t("skills.readOnlyBadge", lang))}</span>` : isCore ? ` <span class="sk-chip sk-chip-flag">${escapeHtml(t("skills.core", lang))}</span>` : "";
    const editBtn = isReadOnly ? "" : `<a href="/dashboard/skills?edit=context-${encodeURIComponent(row.section_key)}" class="btn btn-secondary" style="margin-top:0.5rem">${t("skills.edit", lang)}</a>`;
    return `<details class="sk-ctx"><summary class="sk-sec-h"><b>${escapeHtml(row.section_title || row.section_key)}</b>${chipHtml}</summary><div class="sk-card-body"><pre class="sk-pre">${escapeHtml(row.content || "")}</pre>${editBtn}</div></details>`;
  }).join("");
  const crowContextSection = `<section class="sk-sec sk-card"><div class="sk-sec-h"><b>${t("skills.crowContext", lang)}</b><span class="sk-sec-count">${escapeHtml(fill(t("skills.sectionsCount", lang), { n: contextRows.length }))}</span></div>${contextCards || `<p class="sk-muted sk-card-body">${t("skills.noContextSections", lang)}</p>`}</section>`;
  return SKILLS_CSS + `<div class="sk-page sk-behavior">
    <p><a class="sk-back" href="/dashboard/skills">${escapeHtml(t("skills.backToSkills", lang))}</a></p>
    <h2 class="sk-behavior-h">${escapeHtml(t("skills.behaviorTitle", lang))}</h2>
    ${writingRulesSection}${crowContextSection}
  </div>`;
}
