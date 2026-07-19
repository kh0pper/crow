/**
 * Onboarding starter content (C1/C3).
 *
 * Seeds a handful of `source='starter'` rows into `memories` during the
 * first-run wizard so a brand-new install isn't a completely empty Memory
 * panel — genuinely useful, recallable facts about Crow itself, written in
 * Crow's first-person-neutral voice.
 *
 * Writes go straight through SQL rather than the memory MCP server:
 * this module runs inside the gateway process at wizard time, before any
 * MCP round-trip is available and before any embedding provider is
 * configured. That's fine — FTS works with zero embedding providers
 * (servers/memory/server.js:176-214); `crow_regenerate_embeddings`
 * backfills vector search later once a provider exists.
 *
 * Task 3 extends this module with the starter agent + conversation
 * (createStarterArtifacts): a `crow-starter` pi_bot_defs row built from the
 * "personal-assistant" Bot Builder template, plus a matching
 * chat_conversations row pre-populated with the same persona/system_prompt
 * so the first-run chat and the pi bot behave identically. Both point at
 * whatever provider/model resolveStarterProvider() picks — see its doc
 * comment for the selection order.
 *
 * Sync: starter rows are per-install by construction and must never ride to
 * paired instances — servers/sharing/instance-sync.js's shouldSyncRow
 * excludes any `memories` row with source='starter' (same convention as
 * providers' gpu_policy.local_only), which is the single choke point for
 * both emit and apply. Because of that, clearStarterMemories does NOT emit
 * per-row delete sync events even when a syncManager is supplied: no peer
 * ever received these rows (they never synced in), so a delete-apply would
 * be a guaranteed no-op — simpler and safer to just skip it entirely rather
 * than pay the emit cost for zero effect.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { getTemplate, applyTemplate } from "../bot-builder/templates.js";
import { defaultDefinition } from "../bot-builder/data-queries.js";
import { readSetting, upsertSetting } from "../../settings/registry.js";
import { t } from "../../shared/i18n.js";

const __filename = fileURLToPath(import.meta.url);
// onboarding/starter-content.js -> panels -> dashboard -> gateway -> servers
// -> repo root -> registry/model-catalog.json
const MODEL_CATALOG_PATH = resolvePath(
  dirname(__filename),
  "..", "..", "..", "..", "..",
  "registry", "model-catalog.json"
);

export const STARTER_SOURCE = "starter";
export const STARTER_BOT_ID = "crow-starter";
const STARTER_CONVERSATION_SETTING_KEY = "starter_conversation_id";

const STARTER_MEMORIES = {
  en: [
    {
      content:
        "Crow is your private AI that remembers. Anything you tell it to remember is stored here on your own machine — nothing leaves unless you pair or share it.",
      category: "general",
      context: null,
      tags: "crow,starter,about",
      importance: 5,
    },
    {
      content:
        "To save something, just say 'remember that …' in chat. To find it later, ask 'what do you remember about …'.",
      category: "process",
      context: null,
      tags: "memory,starter,how-to",
      importance: 5,
    },
    {
      content:
        "The dashboard sidebar has Memory (browse everything saved), Messages (chat), Bot Builder (create agents), and Extensions (add abilities like blogs, research, and file storage).",
      category: "general",
      context: null,
      tags: "dashboard,starter,where",
      importance: 5,
    },
    {
      content:
        "Your AI model runs locally. You can download bigger models or switch models in the Model Catalog panel; cloud providers can be added in Settings under AI.",
      category: "process",
      context: null,
      tags: "models,starter",
      importance: 5,
    },
    {
      content:
        "These starter memories are examples seeded during setup. You can delete them all at once in Settings, Help and Setup.",
      category: "general",
      context: null,
      tags: "starter,cleanup",
      importance: 5,
    },
  ],
  es: [
    {
      content:
        "Crow es tu IA privada que recuerda. Todo lo que le pidas recordar se guarda aquí, en tu propio equipo — nada sale de aquí a menos que lo emparejes o lo compartas.",
      category: "general",
      context: null,
      tags: "crow,starter,about",
      importance: 5,
    },
    {
      content:
        "Para guardar algo, solo di 'recuerda que …' en el chat. Para encontrarlo después, pregunta '¿qué recuerdas sobre …?'.",
      category: "process",
      context: null,
      tags: "memory,starter,how-to",
      importance: 5,
    },
    {
      content:
        "La barra lateral del panel tiene Memoria (explora todo lo guardado), Mensajes (chat), Bot Builder (crea agentes) y Extensiones (añade funciones como blogs, investigación y almacenamiento de archivos).",
      category: "general",
      context: null,
      tags: "dashboard,starter,where",
      importance: 5,
    },
    {
      content:
        "Tu modelo de IA se ejecuta localmente. Puedes descargar modelos más grandes o cambiar de modelo en el panel de Catálogo de Modelos; los proveedores en la nube se pueden añadir en Configuración, en AI.",
      category: "process",
      context: null,
      tags: "models,starter",
      importance: 5,
    },
    {
      content:
        "Estas memorias iniciales son ejemplos creados durante la configuración. Puedes eliminarlas todas a la vez en Configuración, en Ayuda y configuración inicial.",
      category: "general",
      context: null,
      tags: "starter,cleanup",
      importance: 5,
    },
  ],
};

/**
 * Seed the starter memories for the given language into `memories`.
 * Idempotent: if any `source='starter'` row already exists, this is a
 * no-op (handles both re-running the wizard and a second gateway racing
 * the same first-run path).
 *
 * @param {{execute: (arg: {sql: string, args: any[]}) => Promise<any>}} db
 * @param {string} lang - "en" | "es" (falls back to "en" if unknown)
 * @returns {Promise<{inserted: number, skipped: boolean}>}
 */
export async function seedStarterMemories(db, lang) {
  const existing = await db.execute({
    sql: "SELECT COUNT(*) n FROM memories WHERE source = ?",
    args: [STARTER_SOURCE],
  });
  if (Number(existing.rows[0].n) > 0) {
    return { inserted: 0, skipped: true };
  }

  const rows = STARTER_MEMORIES[lang] || STARTER_MEMORIES.en;
  for (const row of rows) {
    await db.execute({
      sql: "INSERT INTO memories (content, category, context, tags, source, importance) VALUES (?,?,?,?, 'starter', ?)",
      args: [row.content, row.category, row.context, row.tags, row.importance],
    });
  }
  return { inserted: rows.length, skipped: false };
}

/**
 * Delete all starter-seeded memories. Used by the Settings > Help and Setup
 * "clear starter memories" action (Task 4).
 *
 * @param {{execute: (arg: {sql: string, args: any[]}) => Promise<any>}} db
 * @param {{syncManager?: object}} [opts] - accepted for interface
 *   stability with future callers; deliberately unused (see module
 *   docblock — starter rows never sync, so there's nothing to emit).
 * @returns {Promise<{deleted: number}>}
 */
export async function clearStarterMemories(db, { syncManager } = {}) {
  const result = await db.execute({
    sql: "DELETE FROM memories WHERE source = ?",
    args: [STARTER_SOURCE],
  });
  return { deleted: Number(result.rowsAffected || 0) };
}

/**
 * Pick the provider/model pair the starter agent + conversation should use.
 *
 * Order:
 *   1. The catalog's `first_run_default` model id, IF a non-disabled
 *      `providers` row with that exact id exists. Native model registration
 *      (servers/gateway/models/manager.js registerModel) always registers a
 *      provider whose id IS the catalog model id, so this row existing is
 *      the marker that the recommended first-run model is actually running
 *      locally — providerId and modelId are both that catalog id.
 *   2. Else the newest enabled provider that has at least one model
 *      (`ORDER BY rowid DESC` — rowid tracks insertion order even though
 *      `id` is a TEXT primary key). modelId is the first entry of its
 *      `models` JSON. Providers with an empty `models` array (e.g. a
 *      no_auto_provider placeholder row) are unusable for chat and skipped.
 *   3. Else null — no provider is usable yet (e.g. a totally fresh install
 *      before any model has been registered).
 *
 * @param {{execute: (arg: {sql: string, args: any[]}) => Promise<any>}} db
 * @returns {Promise<{providerId: string, modelId: string} | null>}
 */
export async function resolveStarterProvider(db) {
  let firstRunDefaultId = null;
  try {
    const catalog = JSON.parse(readFileSync(MODEL_CATALOG_PATH, "utf8"));
    const model = (catalog.models || []).find((m) => m.first_run_default === true);
    firstRunDefaultId = model ? model.id : null;
  } catch {
    // Catalog missing/unreadable — fall through to the provider scan.
  }

  if (firstRunDefaultId) {
    const { rows } = await db.execute({
      sql: "SELECT id FROM providers WHERE id = ? AND disabled = 0",
      args: [firstRunDefaultId],
    });
    if (rows.length) {
      return { providerId: firstRunDefaultId, modelId: firstRunDefaultId };
    }
  }

  const { rows } = await db.execute({
    sql: "SELECT id, models FROM providers WHERE disabled = 0 ORDER BY rowid DESC",
    args: [],
  });
  for (const row of rows) {
    let models;
    try {
      models = JSON.parse(row.models || "[]");
    } catch {
      models = [];
    }
    if (Array.isArray(models) && models.length && models[0] && models[0].id) {
      return { providerId: row.id, modelId: models[0].id };
    }
  }

  return null;
}

/**
 * Build the shared persona/system_prompt text used by BOTH the starter bot
 * def and the starter conversation (single source, per Task 3 spec) — the
 * "personal-assistant" template's prompt plus a short memory-first addendum.
 * Small models narrate tool use instead of emitting it
 * (servers/gateway/routes/llm-router.js:48-53), so the addendum explicitly
 * instructs the tool call rather than just describing memory as a capability.
 *
 * @param {object} tpl - a BOT_TEMPLATES entry (from getTemplate)
 * @returns {string}
 */
function buildStarterPersona(tpl) {
  return (
    `${tpl.system_prompt} When the user asks what you remember, or asks you ` +
    `to remember something, you MUST use your memory tools and actually make ` +
    `the tool call — never describe or narrate it instead. Starter memories ` +
    `about Crow exist; recall answers from them.`
  );
}

/**
 * Create the starter agent (`crow-starter` pi_bot_defs row) and its matching
 * starter conversation (chat_conversations row), idempotently.
 *
 * Idempotency: the `dashboard_settings` key `starter_conversation_id` is the
 * source of truth for "did this already run" — a title-based lookup is
 * fragile across language switches/renames. On entry, if that setting is
 * set AND the referenced conversation row still exists, the existing ids are
 * returned as-is (no re-resolution of provider/model, no new rows) even if
 * resolveStarterProvider() would now pick something different. The bot def
 * itself is separately idempotent on `bot_id = 'crow-starter'` (SELECT
 * before INSERT) so a second call after a wiped `dashboard_settings` row
 * still can't create a duplicate bot.
 *
 * @param {{execute: (arg: {sql: string, args: any[]}) => Promise<any>}} db
 * @param {{lang?: string}} [opts] - "en" | "es" (falls back to "en")
 * @returns {Promise<
 *   {conversationId: number, botId: string, providerId: string, modelId: string}
 *   | {error: "no_provider"}
 * >}
 */
export async function createStarterArtifacts(db, { lang } = {}) {
  const existingConvIdRaw = await readSetting(db, STARTER_CONVERSATION_SETTING_KEY);
  if (existingConvIdRaw) {
    const existingConvId = Number(existingConvIdRaw);
    const { rows } = await db.execute({
      sql: "SELECT id, provider, model FROM chat_conversations WHERE id = ?",
      args: [existingConvId],
    });
    if (rows.length) {
      return {
        conversationId: existingConvId,
        botId: STARTER_BOT_ID,
        providerId: rows[0].provider,
        modelId: rows[0].model,
      };
    }
    // Setting points at a row that no longer exists (e.g. deleted by the
    // operator) — fall through and recreate.
  }

  const resolved = await resolveStarterProvider(db);
  if (!resolved) return { error: "no_provider" };
  const { providerId, modelId } = resolved;

  const tpl = getTemplate("personal-assistant");
  const def = defaultDefinition(STARTER_BOT_ID, null, `${providerId}/${modelId}`);
  applyTemplate(def, tpl, {
    availableMcp: new Set(tpl.tools.crow_mcp),
    availableSkills: new Set(tpl.skills),
  });
  const persona = buildStarterPersona(tpl);
  def.system_prompt = persona;

  const existingBot = await db.execute({
    sql: "SELECT bot_id FROM pi_bot_defs WHERE bot_id = ?",
    args: [STARTER_BOT_ID],
  });
  if (!existingBot.rows.length) {
    const displayName = t("starter.botName", lang);
    await db.execute({
      sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id, enabled) VALUES (?,?,?,NULL,1)",
      args: [STARTER_BOT_ID, displayName, JSON.stringify(def)],
    });
  }

  const title = t("starter.convTitle", lang);
  const convResult = await db.execute({
    sql: "INSERT INTO chat_conversations (title, provider, model, system_prompt) VALUES (?,?,?,?)",
    args: [title, providerId, modelId, persona],
  });
  const conversationId = Number(convResult.lastInsertRowid);

  await upsertSetting(db, STARTER_CONVERSATION_SETTING_KEY, String(conversationId));

  return { conversationId, botId: STARTER_BOT_ID, providerId, modelId };
}
