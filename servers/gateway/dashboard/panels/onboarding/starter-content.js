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
 * Task 3 extends this module with the starter agent + conversation: keep
 * exports limited to STARTER_SOURCE, seedStarterMemories, and
 * clearStarterMemories.
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

export const STARTER_SOURCE = "starter";

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
