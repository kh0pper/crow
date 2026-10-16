// The Design kit as seen by Crow core and its consumers (spec §4.3, §4.4, D8).
// Consumer-agnostic: Artifacts uses it today, Workspace next. No bare imports.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The installed kit's directory, or null. "Installed" = listed in
 *  <crowHome>/installed.json AND its library + API files are present. */
export function installedKitDir(crowHome) {
  if (!crowHome) return null;
  const dir = join(crowHome, "bundles", "design-kit");
  if (!existsSync(join(dir, "lib", "manifest.json")) || !existsSync(join(dir, "server", "kit.js"))) return null;
  let list;
  try { list = JSON.parse(readFileSync(join(crowHome, "installed.json"), "utf8")); } catch { return null; }
  const ids = Array.isArray(list) ? list.map((x) => (typeof x === "string" ? x : x && x.id)) : [];
  return ids.includes("design-kit") ? dir : null;
}

// ---- House style (spec §4.4, D4/D5): off unless set; project > bot default > none ----
export const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FONT_NAME_RE = /^font:[a-z0-9][a-z0-9-]{0,39}$/;

/** The bot definition's default theme id, or null. */
export function botThemeOf(def) {
  const t = def && def.design && def.design.house_style;
  return typeof t === "string" ? t : null;
}

/** Project wins, then the bot default; only ids the installed kit knows. */
export function pickHouseStyle({ projectTheme = null, botTheme = null, known } = {}) {
  const ok = (t) => typeof t === "string" && THEME_ID_RE.test(t) && known instanceof Set && known.has(t);
  if (ok(projectTheme)) return projectTheme;
  return ok(botTheme) ? botTheme : null;
}

/** The installed kit's themes as id → { name, fonts }; empty when not installed. */
export function readKitThemes(crowHome) {
  const dir = installedKitDir(crowHome);
  if (!dir) return new Map();
  try {
    const doc = JSON.parse(readFileSync(join(dir, "lib", "themes.json"), "utf8"));
    const out = new Map();
    for (const [id, t] of Object.entries((doc && doc.themes) || {})) {
      if (!THEME_ID_RE.test(id)) continue;
      const fonts = [...new Set([t && t.fonts && t.fonts.heading, t && t.fonts && t.fonts.body])].filter((f) => typeof f === "string" && FONT_NAME_RE.test(f));
      out.set(id, { name: String((t && t.name) || id).replace(/[^\p{L}\p{N} ]/gu, "").slice(0, 60) || id, fonts });
    }
    return out;
  } catch { return new Map(); }
}

/** What a PAGE must <link> to use a house style (review M3). Pages are written
 *  by the bot, so nothing is injected; documents and diagrams get these links
 *  in their head automatically. Paths follow the kit's layout convention. */
export function houseStyleLinks(id, theme) {
  if (typeof id !== "string" || !THEME_ID_RE.test(id)) return [];
  return [...(theme && theme.fonts ? theme.fonts : []).map((f) => `__lib/font/${f.slice(5)}/font.css`), `__lib/themes/${id}.css`];
}

// An archived project's (or a learner profile's) stale style does not apply
// (review L8): the bot falls back to its own default.
const PROJECT_THEME_SQL = "SELECT h.theme FROM design_house_styles h JOIN project_spaces p ON p.uuid=h.project_uuid WHERE p.id=? AND p.type<>'learner_profile' AND p.status<>'archived' AND p.archived_at IS NULL";

/** Bot spawn (better-sqlite3, sync). Missing tables read as no theme. */
export function readHouseStyleSync(conn, { projectId = null, def = null, known } = {}) {
  let projectTheme = null;
  if (projectId != null) {
    try {
      const r = conn.prepare(PROJECT_THEME_SQL).get(Number(projectId));
      projectTheme = r ? r.theme : null;
    } catch { projectTheme = null; }
  }
  return pickHouseStyle({ projectTheme, botTheme: botThemeOf(def), known });
}

/** Artifacts save path (createDbClient, async). */
export async function readHouseStyle(db, botId, { known } = {}) {
  let row = null;
  try { row = (await db.execute({ sql: "SELECT definition, project_id FROM pi_bot_defs WHERE bot_id=?", args: [String(botId)] })).rows[0] || null; } catch { row = null; }
  if (!row) return null;
  let def = null;
  try { def = JSON.parse(row.definition || "{}"); } catch { def = null; }
  let projectTheme = null;
  if (row.project_id != null) {
    try {
      projectTheme = (await db.execute({ sql: PROJECT_THEME_SQL, args: [Number(row.project_id)] })).rows[0]?.theme ?? null;
    } catch { projectTheme = null; }
  }
  return pickHouseStyle({ projectTheme, botTheme: botThemeOf(def), known });
}
