/**
 * Skills Panel — Browse, view, edit, and manage AI skill files
 *
 * Skills are markdown files that define AI behavior and workflows.
 * - Repo skills: skills/*.md (shipped with Crow, read-only here)
 * - User skills: ~/.crow/skills/*.md (user overrides, editable)
 * User skills take precedence over repo skills with the same filename.
 */

import { escapeHtml, section, formField, badge, dataTable } from "../shared/components.js";
import { t, tJs } from "../shared/i18n.js";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, mkdirSync } from "fs";
import { join, basename, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_SKILLS_DIR = join(__dirname, "../../../../skills");
const USER_SKILLS_DIR = join(homedir(), ".crow", "skills");

function listSkillFiles(dir) {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

function readSkillContent(filePath) {
  try {
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
      const { action } = req.body;

      if (action === "save") {
        const { filename, content } = req.body;
        if (filename && content) {
          const safeName = basename(filename).replace(/[^a-z0-9._-]/gi, "");
          if (safeName.endsWith(".md")) {
            mkdirSync(USER_SKILLS_DIR, { recursive: true });
            writeFileSync(join(USER_SKILLS_DIR, safeName), content, "utf-8");
          }
        }
        res.redirectAfterPost("/dashboard/skills");
        return;
      }

      if (action === "delete") {
        const { filename } = req.body;
        if (filename) {
          const safeName = basename(filename).replace(/[^a-z0-9._-]/gi, "");
          const filePath = join(USER_SKILLS_DIR, safeName);
          if (existsSync(filePath)) {
            unlinkSync(filePath);
          }
        }
        res.redirectAfterPost("/dashboard/skills");
        return;
      }

      if (action === "create") {
        const { filename, content } = req.body;
        if (filename && content) {
          let safeName = basename(filename).replace(/[^a-z0-9._-]/gi, "");
          if (!safeName.endsWith(".md")) safeName += ".md";
          mkdirSync(USER_SKILLS_DIR, { recursive: true });
          const filePath = join(USER_SKILLS_DIR, safeName);
          if (!existsSync(filePath)) {
            writeFileSync(filePath, content, "utf-8");
          }
        }
        res.redirectAfterPost("/dashboard/skills");
        return;
      }

      if (action === "save-writing-rules") {
        const { content } = req.body;
        await db.execute({
          sql: 'UPDATE crow_context SET content = ?, updated_at = datetime("now") WHERE section_key = ? AND device_id IS NULL AND project_id IS NULL',
          args: [content, "writing_style"],
        });
        res.redirectAfterPost("/dashboard/skills");
        return;
      }

      if (action === "save-context-section") {
        const { sectionKey, content } = req.body;
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
          sql: 'UPDATE crow_context SET content = ?, updated_at = datetime("now") WHERE section_key = ? AND device_id IS NULL AND project_id IS NULL',
          args: [content, sectionKey],
        });
        res.redirectAfterPost("/dashboard/skills");
        return;
      }
    }

    // Handle writing rules edit view
    const editParam = req.query.edit;
    if (editParam === "writing-rules") {
      const result = await db.execute({
        sql: "SELECT content FROM crow_context WHERE section_key = 'writing_style' AND device_id IS NULL AND project_id IS NULL",
        args: [],
      });
      const currentContent = result.rows[0]?.content || "";
      const editForm = `
        <form method="POST">
          <input type="hidden" name="action" value="save-writing-rules">
          ${formField("Writing Rules", "content", { type: "textarea", value: currentContent, rows: 20, required: true })}
          <div style="display:flex;gap:0.5rem;margin-top:1rem">
            <button type="submit" class="btn btn-primary">Save</button>
            <a href="/dashboard/skills" class="btn btn-secondary">Cancel</a>
          </div>
        </form>`;
      const editContent = section("Writing Rules", editForm);
      return layout({ title: "Edit Writing Rules", content: editContent });
    }

    // Handle crow context section edit view
    if (editParam && editParam.startsWith("context-")) {
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
          ${formField(escapeHtml(row.section_title || sectionKey), "content", { type: "textarea", value: row.content || "", rows: 20, required: true })}
          <div style="display:flex;gap:0.5rem;margin-top:1rem">
            <button type="submit" class="btn btn-primary">Save</button>
            <a href="/dashboard/skills" class="btn btn-secondary">Cancel</a>
          </div>
        </form>`;
      const editContent = section(escapeHtml(row.section_title || sectionKey), editForm);
      return layout({ title: `Edit: ${row.section_title || sectionKey}`, content: editContent });
    }

    // Handle skill file edit view
    const editFile = editParam;
    const editSource = req.query.source; // "user" or "repo"
    if (editFile) {
      const safeName = basename(editFile).replace(/[^a-z0-9._-]/gi, "");
      const isUserSkill = editSource === "user";
      const filePath = isUserSkill
        ? join(USER_SKILLS_DIR, safeName)
        : join(REPO_SKILLS_DIR, safeName);
      const content = readSkillContent(filePath);

      if (content === null) {
        res.redirect("/dashboard/skills");
        return;
      }

      const readOnly = !isUserSkill;
      const sourceLabel = isUserSkill ? t("skills.userSkillEditable", lang) : t("skills.builtInReadOnly", lang);

      let editForm;
      if (readOnly) {
        // Read-only view for repo skills with "Override" button
        editForm = `
          <div style="margin-bottom:1rem">
            ${badge(sourceLabel, "draft")}
          </div>
          <pre style="background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:8px;padding:1rem;overflow-x:auto;font-size:0.85rem;line-height:1.6;max-height:600px;overflow-y:auto;white-space:pre-wrap;word-wrap:break-word">${escapeHtml(content)}</pre>
          <div style="display:flex;gap:0.5rem;margin-top:1rem">
            <form method="POST">
              <input type="hidden" name="action" value="save">
              <input type="hidden" name="filename" value="${escapeHtml(safeName)}">
              <input type="hidden" name="content" value="${escapeHtml(content)}">
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
          <form method="POST">
            <input type="hidden" name="action" value="save">
            <input type="hidden" name="filename" value="${escapeHtml(safeName)}">
            ${formField(t("skills.contentLabel", lang), "content", { type: "textarea", value: content, rows: 20, required: true })}
            <div style="display:flex;gap:0.5rem;margin-top:1rem">
              <button type="submit" class="btn btn-primary">${t("skills.save", lang)}</button>
              <a href="/dashboard/skills" class="btn btn-secondary">${t("skills.cancel", lang)}</a>
              <form method="POST" style="display:inline;margin-left:auto" onsubmit="return confirm('${tJs("skills.deleteUserSkillConfirm", lang)}')">
                <input type="hidden" name="action" value="delete">
                <input type="hidden" name="filename" value="${escapeHtml(safeName)}">
                <button type="submit" class="btn btn-sm btn-danger">${t("skills.delete", lang)}</button>
              </form>
            </div>
          </form>`;
      }

      const editContent = section(`${escapeHtml(safeName)}`, editForm);
      return layout({ title: `${t("skills.skillPrefix", lang)} ${safeName}`, content: editContent });
    }

    // --- Main skills list ---
    const repoSkills = listSkillFiles(REPO_SKILLS_DIR);
    const userSkills = listSkillFiles(USER_SKILLS_DIR);

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
        ? join(USER_SKILLS_DIR, filename)
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
      : dataTable([t("skills.tableName", lang), t("skills.tableFile", lang), t("skills.tableSource", lang), t("skills.tableActions", lang)], rows);

    // Create form
    const createForm = `<form method="POST">
      <input type="hidden" name="action" value="create">
      ${formField(t("skills.filenameLabel", lang), "filename", { placeholder: t("skills.filenamePlaceholder", lang), required: true })}
      ${formField(t("skills.contentLabel", lang), "content", { type: "textarea", required: true, placeholder: "# My Skill\\n\\n## Description\\nWhat this skill does...\\n\\n## When to Use\\n- When the user asks to...\\n\\n## Workflow\\n1. ...", rows: 10 })}
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
        <p style="color:var(--crow-text-secondary);font-style:italic;margin-bottom:1rem">Define rules Crow follows for all writing. Both you and your AI can edit these.</p>
        <a href="/dashboard/skills?edit=writing-rules" class="btn btn-sm btn-primary">Set Up Writing Rules</a>`;
    } else {
      writingRulesBody = `
        <pre style="background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:8px;padding:1rem;overflow-x:auto;font-size:0.85rem;line-height:1.6;max-height:300px;overflow-y:auto;white-space:pre-wrap;word-wrap:break-word">${escapeHtml(writingStyleContent)}</pre>
        <div style="margin-top:0.75rem">
          <a href="/dashboard/skills?edit=writing-rules" class="btn btn-sm btn-secondary">Edit</a>
        </div>`;
    }

    const writingRulesSection = `<div class="card" style="margin-bottom:1.5rem;border-left:3px solid #4caf50">
      <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;padding-bottom:0.5rem;border-bottom:1px solid var(--crow-border)">
        <h3 style="font-family:'Fraunces',serif;font-size:1.1rem;margin:0">Writing Rules</h3>
        ${badge("Always Active", "connected")}
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
          badgeHtml = ` ${badge("Auto-generated", "draft")}`;
        } else if (isCore) {
          badgeHtml = ` ${badge("Core", "warning")}`;
        }

        const editBtn = isReadOnly
          ? ""
          : `<a href="/dashboard/skills?edit=context-${encodeURIComponent(row.section_key)}" class="btn btn-sm btn-secondary" style="margin-top:0.5rem">Edit</a>`;

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

    const crowContextBody = contextCards || `<p style="color:var(--crow-text-secondary)">No context sections found.</p>`;
    const crowContextSection = `<div class="card" style="margin-bottom:1.5rem">
      <details>
        <summary style="cursor:pointer">
          <h3 style="font-family:'Fraunces',serif;font-size:1.1rem;display:inline">Crow Context (crow.md)</h3>
          <span style="color:var(--crow-text-muted);font-size:0.85rem;margin-left:0.5rem">${contextRows.filter((r) => r.section_key !== "writing_style").length} sections</span>
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

    const content = `
      ${writingRulesSection}
      ${crowContextSection}
      ${marketplaceLink}
      ${section(t("skills.allSkills", lang), skillsTable, { delay: 150 })}
      ${section(t("skills.createNewSkill", lang), createForm, { delay: 200 })}
    `;

    return layout({ title: t("skills.pageTitle", lang), content });
  },
};
