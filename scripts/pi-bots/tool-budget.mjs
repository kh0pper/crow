/**
 * Tool budgets (perch strands plan, strand 2 rev 4). Some serving engines
 * refuse a request that offers more function tools than they accept, and the
 * failure used to surface only as a provider 400 on every turn. This module
 * answers "how many tools may this model be offered?" from DATA, so raising an
 * engine's limit is a provider-row edit, never a Crow release:
 *
 *   1. the model entry's own `maxTools` (providers.models[i].maxTools),
 *   2. else an engine-kind default: a provider whose gpu_policy names the gufo
 *      engine gets gufo's shipped limit (128 functions, counted flattened),
 *   3. else no cap.
 *
 * Every read fails OPEN (null = no cap): a cap that cannot be read must never
 * stop a bot from running. The count is entries in the csv pinned into pi's
 * `--tools` (exact-name matching), which can over-count a server that failed
 * to start or a duplicate entry — near the cap that can refuse a surface the
 * engine would have taken.
 */
import Database from "better-sqlite3";
import { botsDbPath } from "./instance-paths.mjs";

/** gufo's shipped limit ('tools' supports at most 128 functions). */
export const GUFO_DEFAULT_MAX_TOOLS = 128;

/** Entries in a pinned `--tools` csv ("" is a real, deliberate zero). */
export function countCsvTools(csv) {
  if (csv == null) return null;
  const n = String(csv).split(",").filter((x) => x.trim()).length;
  return Number.isFinite(n) ? n : null;
}

const positiveInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);

function readProviderRow(provider) {
  let d;
  try {
    // busy_timeout-only, read-only, short-lived — never createDbClient (the
    // bridge must not WAL-flip a prod crow.db; same idiom as model_resolver).
    d = new Database(botsDbPath(), { readonly: true, fileMustExist: true });
    d.pragma("busy_timeout = 10000");
    try {
      return d.prepare("SELECT models, gpu_policy FROM providers WHERE id=?").get(provider) || null;
    } catch {
      // A DB from before the gpu_policy migration: the model field still counts.
      return d.prepare("SELECT models FROM providers WHERE id=?").get(provider) || null;
    }
  } catch {
    return null;
  } finally {
    if (d) { try { d.close(); } catch { /* already closed */ } }
  }
}

/** The tool cap for a resolved {provider, model}, or null for none/unknown. */
export function capFor(resolved) {
  if (!resolved || !resolved.provider || !resolved.model) return null;
  const row = readProviderRow(resolved.provider);
  if (!row) return null;
  try {
    const models = JSON.parse(row.models || "[]");
    const entry = Array.isArray(models) ? models.find((m) => m && m.id === resolved.model) : null;
    const own = entry ? positiveInt(entry.maxTools) : null;
    if (own) return own;
  } catch { /* fall through to the engine default */ }
  try {
    const policy = row.gpu_policy ? JSON.parse(row.gpu_policy) : null;
    if (policy && policy.engine && policy.engine.label === "gufo") return GUFO_DEFAULT_MAX_TOOLS;
  } catch { /* junk policy → no cap */ }
  return null;
}

/** {ok, count, cap, near}: near = allowed but within 10% of the cap. */
export function checkToolBudget(csv, cap) {
  const count = countCsvTools(csv) || 0;
  if (!positiveInt(cap)) return { ok: true, count, cap: null, near: false };
  return { ok: count <= cap, count, cap, near: count <= cap && count >= cap * 0.9 };
}

/** Perch: the session's model is over its cap. */
export function sessionBudgetMessage({ count, cap, model }) {
  return "This session's model (" + model + ") accepts at most " + cap + " tools; this bot has " + count +
    ". Pick another model for this session, untick services in Bot Builder, or change the bot's default model.";
}

/** Channels: said to a correspondent, so no provider or model id. */
export function channelBudgetMessage({ count, cap }) {
  return "This bot has more tools (" + count + ") than its model accepts (" + cap + "), so it can't answer. " +
    "Its operator needs to untick services in Bot Builder or change its model.";
}
