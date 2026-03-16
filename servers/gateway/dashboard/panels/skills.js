/**
 * Skills Panel — Browse, view, edit, and manage AI skill files
 *
 * Skills are markdown files that define AI behavior and workflows.
 * - Repo skills: skills/*.md (shipped with Crow, read-only here)
 * - User skills: ~/.crow/skills/*.md (user overrides, editable)
 * User skills take precedence over repo skills with the same filename.
 */

import { escapeHtml, statCard, statGrid, section, formField, badge, dataTable } from "../shared/components.js";
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
        res.redirect("/dashboard/skills");
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
        res.redirect("/dashboard/skills");
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
        res.redirect("/dashboard/skills");
        return;
      }
    }

    // Handle edit view
    const editFile = req.query.edit;
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
            ${formField("Content", "content", { type: "textarea", value: content, rows: 20, required: true })}
            <div style="display:flex;gap:0.5rem;margin-top:1rem">
              <button type="submit" class="btn btn-primary">Save</button>
              <a href="/dashboard/skills" class="btn btn-secondary">Cancel</a>
              <form method="POST" style="display:inline;margin-left:auto" onsubmit="return confirm('Delete this user skill? The built-in version (if one exists) will be used instead.')">
                <input type="hidden" name="action" value="delete">
                <input type="hidden" name="filename" value="${escapeHtml(safeName)}">
                <button type="submit" class="btn btn-sm btn-danger">Delete</button>
              </form>
            </div>
          </form>`;
      }

      const editContent = section(`${escapeHtml(safeName)}`, editForm);
      return layout({ title: `Skill: ${safeName}`, content: editContent });
    }

    // --- Main skills list ---
    const repoSkills = listSkillFiles(REPO_SKILLS_DIR);
    const userSkills = listSkillFiles(USER_SKILLS_DIR);

    // Build merged list: user skills override repo skills
    const userSkillSet = new Set(userSkills);
    const allSkillNames = [...new Set([...userSkills, ...repoSkills])].sort();

    const stats = statGrid([
      statCard("Total Skills", allSkillNames.length, { delay: 0 }),
      statCard("Built-in", repoSkills.length, { delay: 50 }),
      statCard("Custom", userSkills.length, { delay: 100 }),
    ]);

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
        statusBadge = `${badge("overridden", "connected")} ${badge("built-in", "draft")}`;
      } else if (isUserOnly) {
        statusBadge = badge("custom", "published");
      } else {
        statusBadge = badge("built-in", "draft");
      }

      const viewBtn = `<a href="/dashboard/skills?edit=${encodeURIComponent(filename)}&source=${source}" class="btn btn-sm btn-secondary">${isBuiltIn ? "View" : "Edit"}</a>`;
      const deleteBtn = !isBuiltIn
        ? ` <form method="POST" style="display:inline;margin-left:0.25rem" onsubmit="return confirm('Delete this skill?')"><input type="hidden" name="action" value="delete"><input type="hidden" name="filename" value="${escapeHtml(filename)}"><button class="btn btn-sm btn-danger" type="submit">Delete</button></form>`
        : "";

      return [
        escapeHtml(displayName),
        `<span class="mono" style="font-size:0.8rem">${escapeHtml(name)}</span>`,
        statusBadge,
        `${viewBtn}${deleteBtn}`,
      ];
    });

    const skillsTable = allSkillNames.length === 0
      ? `<div class="empty-state"><h3>No skills found</h3><p>Skills should be in the skills/ directory.</p></div>`
      : dataTable(["Name", "File", "Source", "Actions"], rows);

    // Create form
    const createForm = `<form method="POST">
      <input type="hidden" name="action" value="create">
      ${formField("Filename", "filename", { placeholder: "my-skill.md", required: true })}
      ${formField("Content", "content", { type: "textarea", required: true, placeholder: "# My Skill\\n\\n## Description\\nWhat this skill does...\\n\\n## When to Use\\n- When the user asks to...\\n\\n## Workflow\\n1. ...", rows: 10 })}
      <button type="submit" class="btn btn-primary">Create Skill</button>
    </form>`;

    // Marketplace link
    const marketplaceLink = `<div style="background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:8px;padding:1rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
      <span style="font-weight:600;color:var(--crow-text)">Want more skills?</span>
      <span style="color:var(--crow-text-secondary);flex:1">Browse and install skill bundles from the add-on marketplace.</span>
      <a href="/dashboard/extensions" class="btn btn-sm btn-primary">Extensions</a>
    </div>`;

    const content = `
      ${stats}
      ${marketplaceLink}
      ${section("All Skills", skillsTable, { delay: 150 })}
      ${section("Create New Skill", createForm, { delay: 200 })}
    `;

    return layout({ title: "Skills", content });
  },
};
