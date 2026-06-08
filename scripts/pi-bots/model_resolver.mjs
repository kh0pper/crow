#!/usr/bin/env node
/**
 * Crow Bot Builder — per-bot model resolver (Phase 3.0).
 *
 * Single source of truth for "which provider/model does this bot's pi spawn
 * with this turn". Replaces the bridge's old hardcoded `--provider crow-local`
 * + `def.models.default.split("/").pop()` path (Phase-3 review R3).
 *
 * Decisions baked in (plan POST-REVIEW REVISIONS, Round 1):
 *  - R3: the bridge derives ALL of {--provider, --model, PI_PROVIDER} from
 *        resolveModel() — no residual hardcode.
 *  - R4: escalation is operator-driven via an explicit, bounded, inbound-only
 *        `!escalate` token; the token is stripped before prompt composition.
 *  - R5: resolveModel() returns a fully-attributed object so the bridge can
 *        emit ONE deterministic `[bridge] model-resolve …` log line (the named
 *        escalation-proof observable — get_state does NOT echo the model).
 *  - R12: when `!escalate` is requested but the bot has no usable escalation
 *        model, resolve fails CLOSED to the default AND flags
 *        `escalationRequestedButUnavailable` so the bridge can surface an
 *        in-band reply notice (the Gmail operator never sees stderr).
 *  - Fail-closed: ANY models.json read/parse failure, or an unknown
 *        provider/model key, resolves to LOCAL_FALLBACK. resolveModel() never
 *        throws.
 *
 * `validateModelKey()` is exported for reuse by the Phase-3.2 panel
 * (save-time validation) and the Phase-3.1 MULTI_AGENT_CAPABLE drift check
 * (R11) — single source, mirrors the pi_extensions_allowlist.mjs pattern.
 *
 * Pure w.r.t. the DB: reads only ~/.pi/agent/models.json (fs + JSON.parse, no
 * npm dependency). The CLI reads a bot def from crow.db with busy_timeout
 * ONLY (no journal_mode pragma — WAL-flip-safe, memory
 * crowdb-wal-flip-new-consumers), same as bridge.mjs.
 */
import { readFileSync } from "node:fs";
import { botsDbPath } from "./instance-paths.mjs";

const HOME = "/home/kh0pp";
const MODELS_JSON = process.env.PI_MODELS_JSON || HOME + "/.pi/agent/models.json";
export const LOCAL_FALLBACK = "crow-local/qwen3.6-35b-a3b";

/** Split a "provider/model" key on the FIRST "/" (model ids carry no "/"). */
export function splitKey(key) {
  const s = String(key || "");
  const i = s.indexOf("/");
  if (i < 0) return { provider: "", model: "" };
  return { provider: s.slice(0, i), model: s.slice(i + 1) };
}

function loadModelsFromFile() {
  try {
    const j = JSON.parse(readFileSync(MODELS_JSON, "utf8"));
    return j && j.providers && typeof j.providers === "object" ? j : null;
  } catch {
    return null;
  }
}

async function loadModelsFromDb() {
  try {
    const { default: Database } = await import("/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js");
    const CROW_DB = botsDbPath();
    const d = new Database(CROW_DB);
    d.pragma("busy_timeout = 10000");
    const rows = d.prepare("SELECT id, models FROM providers WHERE disabled=0").all();
    d.close();
    if (!rows.length) return null;
    const providers = {};
    for (const r of rows) {
      try { providers[r.id] = { models: JSON.parse(r.models || "[]") }; } catch {}
    }
    return { providers };
  } catch {
    return null;
  }
}

export async function loadModels() {
  const db = await loadModelsFromDb();
  if (db && db.providers && Object.keys(db.providers).length) return db;
  return loadModelsFromFile();
}

/**
 * Validate a "provider/model" key against a loaded models.json object.
 * @returns {{ok:boolean, provider:string, model:string}}
 */
export function validateModelKey(models, key) {
  const { provider, model } = splitKey(key);
  const ok = !!(
    provider &&
    model &&
    models &&
    models.providers &&
    models.providers[provider] &&
    Array.isArray(models.providers[provider].models) &&
    models.providers[provider].models.some((m) => m && m.id === model)
  );
  return { ok, provider, model };
}

/**
 * Resolve the provider/model a bot's pi should spawn with this turn.
 * @param {object} def  pi_bot_defs.definition (parsed)
 * @param {{escalate?:boolean}} [opts]
 * @returns {{provider:string, model:string, key:string, escalated:boolean,
 *            source:"default"|"escalation"|"fallback",
 *            escalationRequestedButUnavailable:boolean}}
 */
export async function resolveModel(def, opts) {
  const escalate = !!(opts && opts.escalate);
  const models = await loadModels();
  const fb = splitKey(LOCAL_FALLBACK);
  const out = (provider, model, escalated, source, unavailable) => ({
    provider,
    model,
    key: provider + "/" + model,
    escalated: !!escalated,
    source,
    escalationRequestedButUnavailable: !!unavailable,
  });

  const defaultKey = (def && def.models && def.models.default) || LOCAL_FALLBACK;
  const escKey = def && def.models && def.models.escalation;

  if (escalate) {
    const e = validateModelKey(models, escKey);
    if (escKey && e.ok) return out(e.provider, e.model, true, "escalation", false);
    // R12: escalation explicitly requested but unset/invalid → fall to default,
    // flag it so the bridge can post an in-band notice.
    const d = validateModelKey(models, defaultKey);
    if (d.ok) return out(d.provider, d.model, false, "fallback", true);
    return out(fb.provider, fb.model, false, "fallback", true);
  }

  const d = validateModelKey(models, defaultKey);
  if (d.ok) return out(d.provider, d.model, false, "default", false);
  return out(fb.provider, fb.model, false, "fallback", false);
}

/**
 * Operator-driven escalation directive — bounded, applied ONLY to the raw
 * current inbound user message (NEVER plan-file / Kanban / resumed transcript).
 */
const ESCALATE_RE = /(^|\s)!escalate(\s|$)/i;
export function escalateRequested(msg) {
  return ESCALATE_RE.test(String(msg || ""));
}
/** Strip the `!escalate` token(s) so it never reaches the model or transcript. */
export function stripEscalateToken(msg) {
  return String(msg == null ? "" : msg)
    .replace(/(^|\s)!escalate(?=\s|$)/gi, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// CLI: resolve <botId> [--escalate]   (reads the bot def from crow.db)
if (import.meta.url === "file://" + process.argv[1]) {
  const a = process.argv.slice(2);
  if (a[0] !== "resolve" || !a[1]) {
    console.error("usage: model_resolver.mjs resolve <botId> [--escalate]");
    process.exit(2);
  }
  const botId = a[1];
  const escalate = a.includes("--escalate");
  const { default: Database } = await import("/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js");
  const CROW_DB = botsDbPath();
  const d = new Database(CROW_DB);
  d.pragma("busy_timeout = 10000");
  const row = d.prepare("SELECT definition FROM pi_bot_defs WHERE bot_id=?").get(botId);
  d.close();
  if (!row) {
    console.error("unknown bot " + botId);
    process.exit(1);
  }
  const def = JSON.parse(row.definition || "{}");
  console.log(JSON.stringify(await resolveModel(def, { escalate }), null, 2));
  process.exit(0);
}
