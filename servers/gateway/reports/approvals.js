/**
 * Crow Recurring Reports' approvals: going live, pausing, resuming, and the recipe saves that may or
 * may not move a live report.
 *
 * A report is allowed to run only while it carries a go-live seal over the "live set" — the exact
 * revision, the two hashes, the schedule row and its zone, the sender, the bot, the project, the artifact,
 * the delivery rule, the comment defaults, the AI switch and the resolved model — made under the
 * keychain key (reports/seal.js). This module is the only writer of that seal, and every write of it
 * needs an owner actor: `{kind: "owner"}`. A bot may save a recipe (`botSaveRecipe`), and may never
 * re-stamp; an owner route may re-stamp a live report only when nothing the owner approved has moved
 * (the same sources hash, the same model-call status).
 *
 * `isLive` is the reader's whole answer to "may this report run": the status is `live`, a revision row
 * exists for `live_rev`, the schedule resolves and is enabled, the model the recipe needs resolves NOW
 * (never read from the row), and the seal verifies over the report's current values. Any direct UPDATE
 * of a live-set column, or a model resolution that changed, breaks it. It never throws: a broken report
 * is `false`. `verifyLive` is the same answer carrying the verified live set, and the parsed recipe of
 * the sealed revision those hashes came from, instead of a bare boolean.
 *
 * Sealing and verifying never trust the hash columns of the revision row. They parse the sealed
 * revision's own `recipe_json`, recompute both hashes under this module's block registry, and refuse
 * when the recomputed pair disagrees with what the row stores beside it. A direct UPDATE of the recipe
 * text, or of either hash column, therefore cannot leave a seal verifying; and the report head is
 * never read for them, so a later save cannot silently re-bless the seal either.
 *
 * WHAT THE SEAL DOES NOT COVER, stated here so no reader has to infer it:
 *
 *   - `status` is not a sealed field. A direct `UPDATE reports SET status = 'live'` therefore undoes an
 *     owner pause as far as this module's reader is concerned, and only the seal, the schedule, the
 *     revision row and the model resolution stand in the way. A row whose seal still verifies (an owner
 *     pause keeps it, see below) and whose status was flipped back from the outside WOULD read live.
 *     PR 1b's runner must therefore refuse a run whose status was changed outside this module.
 *   - An owner or system pause keeps the seal ON PURPOSE, so a resume can prove that nothing moved while
 *     the report was stopped. What does drop the seal is a settings change to a live-set field on a live
 *     report: the pause and the null live_seal/live_nonce are one write, so flipping the column back
 *     cannot revive the old approval and only a fresh go-live re-approves.
 *   - The pause audit row says `decided: "refused"`. The audit vocabulary
 *     (`report_approvals_audit.decided`, store.js's APPROVAL_DECISIONS) has only approved, refused and
 *     revoked: there is no "paused" word to write, so a pause is recorded as the approval being refused
 *     for as long as the pause lasts.
 *   - The replay limit: an old `live_rev`, `live_seal` and `live_nonce` restored TOGETHER with every
 *     column they were made over still verify. A seal is a tamper check over content, not a capability
 *     and not a clock, so a whole-row rollback is outside what it can see. A partial restore, or a
 *     restore that misses one covered field, does not verify.
 *
 * Every function takes `(db, deps, input)`. `deps` is the whole seam, and each member falls back to
 * the real thing only when it is absent:
 *   - `loadSeed()`: the keychain seed (`{seed}` or the raw bytes). Missing -> `keychain_key_missing`.
 *   - `now()`: epoch ms for audit rows. The stores stamp the report row with their own clock.
 *   - `getRun(db, runId)`: a preview or run row, or null. Runs arrive in PR 1b, so the default answers
 *     null: there is no preview to approve, and go-live therefore cannot succeed in production until
 *     that PR injects the real reader. It is not stubbed out on purpose, it is that the tables do not
 *     exist yet.
 *   - `getSchedule(db, report)`: `{cron, tz}` from the report's `schedules` row, or null. The default
 *     also answers null for a disabled row (`enabled = 0`): a switched-off schedule fires nothing.
 *   - `resolveModelRef(db, report)`: `{providerId, model, locality, baseUrlHost}`, or null.
 *   - `senderReady(db, accountId)`: whether that Crow Mail account can send right now. Nothing is
 *     injected by default and the default answers false (fail closed): the real reader lives in
 *     `reports/sender-ready.js`, which the routes inject, because this module imports nothing under
 *     `mail/`.
 *   - `registry`: the block registry (`{type: {sourceBearing}}`) or null. It is the server's own and
 *     never a caller's. Null counts every block as source-bearing (fail closed) until PR 4a lands the
 *     real one.
 *   - `getSecrets()`: literal secret values a pause reason is scrubbed of.
 *
 * Every refusal is an Error with a `code`: `owner_only`, `not_found`, `bad_input`, `bad_recipe`,
 * `keychain_key_missing`, `preview_missing`, `preview_stale`, `preview_failed`, `no_schedule`,
 * `sender_not_ready`, `model_unresolved`, `go_live_needed`, `bad_seal_field`.
 *
 * Recipients, custom steps, hosts, credential bindings and proposals are later PRs: they have their
 * own kinds in seal.js and no approval path here yet.
 */
import { canonicalJson, recipeCallsModel, recipeHash, sourcesHash } from "./recipe-hash.js";
import { approvalSeal, newApprovalNonce, verifyApprovalSeal } from "./seal.js";
import { getReport, getRevision, recordAudit, saveRecipe, updateReportColumns } from "./store.js";
import { loadKeychainKey } from "../keychain/key.js";
import { resolveProviderConfig } from "../ai/resolve-profile.js";
import { getSecretValues } from "../../shared/secret-values.js";
import { redactSecrets } from "../../shared/redact-secrets.js";
import { isLocallyOrchestratable } from "../../shared/locality.js";

/* ------------------------------------------------------------------------ the words */

/** The only actor kind that may approve anything. */
export const OWNER_ACTOR = Object.freeze({ kind: "owner" });

/** A live report's status word (the store validates none of these: this module owns them). */
export const REPORT_LIVE = "live";
export const REPORT_PAUSED = "paused";

/** The delivery rules a report may carry. */
export const DELIVERY_MODES = Object.freeze(["email_full", "email_link", "both", "crow_only"]);

/** The comment tiers (`a` is the most open) and the two comment visibilities. */
export const COMMENT_TIERS = Object.freeze(["a", "b", "c"]);
export const COMMENT_VISIBILITIES = Object.freeze(["own", "all"]);

/** The head columns `updateSettings` may write. */
export const REPORT_SETTING_KEYS = Object.freeze([
  "sender_account_id", "delivery_mode", "comment_tier_default", "comment_visibility", "ai_commentary",
  "title", "notify_every_run",
]);

/** The five settings that are part of the live set: changing one on a live report stops it. */
const LIVE_SETTING_KEYS = Object.freeze([
  "sender_account_id", "delivery_mode", "comment_tier_default", "comment_visibility", "ai_commentary",
]);

/** The pause reason a live-set settings change leaves (plain words, no dash). */
export const SETTINGS_CHANGED_PAUSE_REASON = "You changed settings. Preview and go live again.";

/** The longest pause reason kept: a wall of text is not a reason, and it is shown on a card. */
const PAUSE_REASON_MAX = 300;

/** The longest title `updateSettings` accepts. */
const TITLE_MAX = 200;

/** C0 controls, DEL, C1 controls and the Unicode line and paragraph separators. */
const CONTROL_CHARS_ALL = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]+/g;

function fail(code, detail) {
  const err = new Error(detail ? `${code}: ${detail}` : code);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

/* --------------------------------------------------------------------------- helpers */

function text(value) {
  if (value == null) return "";
  return typeof value === "string" ? value : String(value);
}

/** A 0/1 column as the number the seal carries. */
function flagNumber(value) {
  return value === 1 || value === true ? 1 : 0;
}

/** The actor rule: every approving function needs the owner and nobody else. */
function requireOwner(actor) {
  if (!actor || typeof actor !== "object" || actor.kind !== "owner") throw fail("owner_only");
  return actor;
}

async function requireReport(db, reportId) {
  if (typeof reportId !== "string" || !reportId) throw fail("bad_input", "reportId");
  const report = await getReport(db, reportId);
  if (!report) throw fail("not_found", "report");
  return report;
}

/** A stored recipe JSON text as an object. A body that is not a recipe is `bad_recipe`. */
function recipeOf(json) {
  if (json == null || json === "") return { blocks: [] };
  try {
    return JSON.parse(json);
  } catch {
    throw fail("bad_recipe", "recipe_json");
  }
}

/** Does this recipe need a model? A recipe this module cannot read counts as needing one. */
function callsModel(recipe, aiFlag) {
  try {
    return recipeCallsModel(recipe, aiFlag);
  } catch {
    return true;
  }
}

/**
 * A resolved model reference as the canonical JSON text the seal carries: `{providerId, model,
 * locality, baseUrlHost}`, or "" when no model is called. `null`, a blank string and an object that
 * cannot be written as canonical JSON all come back as "".
 */
export function modelRefText(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      return canonicalJson(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }
  if (typeof value !== "object") return "";
  try {
    return canonicalJson(value);
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------------ the defaults */

function defaultLoadSeed() {
  return loadKeychainKey()?.seed ?? null;
}

/**
 * There is no run to look up yet: `reports` has no preview or run tables until PR 1b adds them, so the
 * default answers null and go-live refuses with `preview_missing`. PR 1b injects the real reader; this
 * is a missing table, not a stub that pretends a preview exists.
 */
async function defaultGetRun() {
  return null;
}

/**
 * The report's own `schedules` row, or null when it has none, when the row is disabled (`enabled = 0`)
 * or when there is no schedules table. A switched-off schedule is no schedule: nothing will fire, so a
 * report anchored to it must not read as live.
 */
async function defaultGetSchedule(db, report) {
  const raw = report?.schedule_id;
  if (raw == null || raw === "") return null;
  const id = Number(raw);
  if (!Number.isInteger(id)) return null;
  let row;
  try {
    const { rows } = await db.execute({
      sql: "SELECT cron_expression, tz FROM schedules WHERE id = ? AND enabled = 1",
      args: [id],
    });
    row = rows[0];
  } catch {
    return null;
  }
  if (!row || typeof row.cron_expression !== "string" || !row.cron_expression.trim()) return null;
  return { cron: row.cron_expression.trim(), tz: typeof row.tz === "string" ? row.tz : "" };
}

/** A `provider/model` key split on its FIRST slash (model ids carry no slash). */
function splitKey(key) {
  const s = text(key);
  const i = s.indexOf("/");
  if (i <= 0) return { providerId: "", model: "" };
  return { providerId: s.slice(0, i), model: s.slice(i + 1) };
}

/** The host (and port) of a base URL, or "" when it is not a URL. */
function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl)).host;
  } catch {
    return "";
  }
}

/**
 * The model key a bot's own spawn uses: `pi_bot_defs.definition.models.default`, a `provider/model`
 * key or a `role:<id>` reference. A role is resolved against this instance's bindings (the same
 * resolver a bot's session uses), because the key a bot stores may name a role rather than a row.
 * Null when the bot names no model (it runs on the instance default) or the def cannot be read.
 */
async function botModelKey(db, botId) {
  if (typeof botId !== "string" || !botId) return null;
  let definition;
  try {
    const { rows } = await db.execute({
      sql: "SELECT definition FROM pi_bot_defs WHERE bot_id = ?",
      args: [botId],
    });
    definition = rows[0]?.definition;
  } catch {
    return null;
  }
  let def;
  try {
    def = JSON.parse(definition || "{}");
  } catch {
    return null;
  }
  const key = typeof def?.models?.default === "string" ? def.models.default.trim() : "";
  if (!key) return null;
  if (!key.startsWith("role:")) return key;
  try {
    const { resolveRole } = await import("../../shared/model-roles-store.js");
    const resolved = await resolveRole(db, key, { need: "chat" });
    return resolved && typeof resolved.key === "string" && resolved.key ? resolved.key : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the model a report's bot would run with, the way a chat request resolves one: the bot's
 * stored key, then the provider row behind it (a DB row first, then models.json), then the locality of
 * that endpoint. The host is sealed too, so a provider repointed from one cloud endpoint to another
 * under the same id changes the live set.
 *
 * The chain is four existing accessors rather than one: `pi_bot_defs.definition.models.default` (the
 * key every gateway panel reads), `resolveRole` (model-roles-store.js, for a `role:` key),
 * `resolveProviderConfig` (ai/resolve-profile.js, the same resolver /llm/v1 uses) and
 * `isLocallyOrchestratable` (shared/locality.js). There is no single bot-model accessor in the
 * gateway; a caller that wants a different chain injects `resolveModelRef`, and the production
 * callers take this one through `buildApprovalsDeps` (reports/approvals-deps.js).
 */
export async function defaultResolveModelRef(db, report) {
  const key = await botModelKey(db, report?.bot_id);
  if (!key) return null;
  const { providerId, model } = splitKey(key);
  if (!providerId || !model) return null;
  let config;
  try {
    config = await resolveProviderConfig(db, providerId, model);
  } catch {
    return null;
  }
  const baseUrl = text(config?.baseUrl);
  return {
    providerId,
    model: text(config?.model) || model,
    locality: isLocallyOrchestratable({ baseUrl }) ? "local" : "cloud",
    baseUrlHost: hostOf(baseUrl),
  };
}

/**
 * Nothing injected, no sender: fail closed. The real reader is `reports/sender-ready.js`, which reads
 * the Crow Mail account row and its keychain credential, and which the routes inject. This module does
 * not import it (the reports code reaches mail through that one injected seam), so go-live without an
 * injected reader refuses with `sender_not_ready` rather than approving a sender nobody looked at.
 */
async function defaultSenderReady() {
  return false;
}

function defaultGetSecrets() {
  try {
    return getSecretValues();
  } catch {
    return [];
  }
}

/** `deps` with every member present; a member that is absent falls back to the real thing. */
function resolveDeps(deps) {
  const given = deps == null ? {} : deps;
  const fn = (key, fallback) => (typeof given[key] === "function" ? given[key] : fallback);
  return {
    loadSeed: fn("loadSeed", defaultLoadSeed),
    now: fn("now", Date.now),
    getRun: fn("getRun", defaultGetRun),
    getSchedule: fn("getSchedule", defaultGetSchedule),
    resolveModelRef: fn("resolveModelRef", defaultResolveModelRef),
    senderReady: fn("senderReady", defaultSenderReady),
    getSecrets: fn("getSecrets", defaultGetSecrets),
    registry: given.registry ?? null,
  };
}

/** The keychain seed as bytes, or `keychain_key_missing`: no seal can be made without it. */
async function seedOf(deps) {
  const loaded = await deps.loadSeed();
  const seed = loaded == null
    ? null
    : (Buffer.isBuffer(loaded) || loaded instanceof Uint8Array ? loaded : loaded.seed);
  if (!Buffer.isBuffer(seed) && !(seed instanceof Uint8Array)) throw fail("keychain_key_missing");
  if (!seed.length) throw fail("keychain_key_missing");
  return seed;
}

/* ------------------------------------------------------------------------ the live set */

/**
 * One revision's two hashes, recomputed from its own recipe text under `registry`. Null when that text
 * is not a recipe at all (a row a direct UPDATE broke), which every caller treats as a refusal.
 */
function recomputedHashes(revision, registry) {
  if (revision == null) return null;
  let recipe;
  try {
    recipe = recipeOf(revision.recipe_json);
  } catch {
    return null;
  }
  try {
    return { recipeHash: recipeHash(recipe), sourcesHash: sourcesHash(recipe, registry) };
  } catch {
    return null;
  }
}

/**
 * A revision's hashes as the seal carries them: recomputed from the revision's OWN `recipe_json`, and
 * refused (`bad_recipe`) when that pair disagrees with the hash columns stored beside it. The columns
 * are a fast path for readers, never the truth: otherwise a direct UPDATE of the text (a new source
 * URL, a new model block) or of a column would leave a seal verifying over content nobody approved. A
 * report with no revision row yet (a draft at revision 0) hashes as "".
 */
function sealedHashes(revision, registry) {
  if (revision == null) return { recipeHash: "", sourcesHash: "" };
  const hashes = recomputedHashes(revision, registry);
  if (!hashes) throw fail("bad_recipe", "revision_json");
  if (hashes.recipeHash !== text(revision.recipe_hash)
    || hashes.sourcesHash !== text(revision.sources_hash)) {
    throw fail("bad_recipe", "revision_hash");
  }
  return hashes;
}

/** The largest integer a JS number names exactly: an id column past it is not an id the seal made. */
const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;

/** What `idField` answers for a column holding something an id column cannot hold. */
const NOT_AN_ID = Symbol("not-an-id");

/**
 * An id column as the seal carries it: a positive safe-integer NUMBER (or a bigint in that range, which
 * some drivers hand back), "" when the column is unset, and `NOT_AN_ID` for anything else.
 *
 * There is deliberately no coercion. A TEXT column holding "12", "12.0" or "0x0c" is not the number 12
 * the seal was made over even though `Number()` reads all three as 12, and neither is a zero, a
 * negative, a fraction or a number past the safe range an id. A row spelled that way is not live.
 */
function idField(value) {
  if (value == null) return "";
  if (typeof value === "string") return value === "" ? "" : NOT_AN_ID;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : NOT_AN_ID;
  }
  if (typeof value === "bigint") {
    return value > 0n && value <= BigInt(MAX_SAFE_ID) ? Number(value) : NOT_AN_ID;
  }
  return NOT_AN_ID;
}

/**
 * The fields the go-live seal covers, in the shape seal.js's `live` kind takes.
 *
 * Every string is normalised to "" when the column is null, an id column to a number or "", and
 * `aiCommentary` to 0/1, so an untouched row always seals to the same payload. `recipeHash` and
 * `sourcesHash` are recomputed from the revision row for the sealed revision (never from the head
 * columns and never from that row's own hash columns: `sealedHashes` refuses a row whose text and
 * columns disagree), so a later save moves the head without re-blessing the seal. `title` is not a
 * sealed field: it is a label the owner renames freely, and PR 2b must treat it as untrusted text when
 * it uses it as a subject line.
 *
 * `overrides` exists for go-live, the one writer that needs a value before it is on the row: `rev` (the
 * head revision being sealed), `nonce` (the fresh one about to be written) and `modelRef` (resolved a
 * moment ago). Every other writer passes none of them: a re-stamp seals the live set it just verified,
 * so it neither re-reads the schedule nor resolves the model again.
 *
 * @param {object} db
 * @param {object} [deps]
 * @param {object} report a report row
 * @param {{rev?: number, nonce?: string, modelRef?: string}} [overrides]
 * @returns {Promise<object>} the `live` field list including the nonce
 * @throws {Error} `bad_recipe` when the sealed revision's text and its hash columns disagree, or
 *   `bad_input` when an id column holds something that is not an id (a text spelling, a zero, a
 *   fraction): such a row cannot be sealed over, so it never verifies either
 */
export async function liveSetFor(db, deps, report, overrides = {}) {
  const d = resolveDeps(deps);
  if (report == null || typeof report !== "object") throw fail("not_found", "report");
  const over = overrides == null ? {} : overrides;
  const rev = over.rev !== undefined ? over.rev : report.live_rev;
  const revision = Number.isInteger(Number(rev)) ? await getRevision(db, report.id, Number(rev)) : null;
  const hashes = sealedHashes(revision, d.registry);
  const schedule = await d.getSchedule(db, report);
  const projectId = idField(report.project_id);
  const scheduleId = idField(report.schedule_id);
  if (projectId === NOT_AN_ID || scheduleId === NOT_AN_ID) throw fail("bad_input", "id column");
  return {
    reportId: report.id,
    rev: Number.isFinite(Number(rev)) ? Number(rev) : 0,
    recipeHash: hashes.recipeHash,
    sourcesHash: hashes.sourcesHash,
    cron: text(schedule?.cron),
    tz: text(schedule?.tz),
    senderAccountId: text(report.sender_account_id),
    botId: text(report.bot_id),
    projectId,
    artifactId: text(report.artifact_id),
    scheduleId,
    deliveryMode: text(report.delivery_mode),
    commentTierDefault: text(report.comment_tier_default),
    commentVisibility: text(report.comment_visibility),
    aiCommentary: flagNumber(report.ai_commentary),
    modelRef: over.modelRef !== undefined ? modelRefText(over.modelRef) : modelRefText(report.model_ref),
    nonce: text(over.nonce !== undefined ? over.nonce : report.live_nonce),
  };
}

/**
 * The model reference a revision needs, resolved afresh: "" when that recipe calls no model,
 * otherwise the canonical text of what `deps.resolveModelRef` answers now. Null when the recipe needs a
 * model and none resolved.
 */
async function freshModelRef(db, deps, report, revision) {
  if (!revision) return "";
  let recipe;
  try {
    recipe = recipeOf(revision.recipe_json);
  } catch {
    return null;
  }
  if (!callsModel(recipe, report.ai_commentary)) return "";
  const resolved = await deps.resolveModelRef(db, report);
  const ref = modelRefText(resolved);
  return ref === "" ? null : ref;
}

/**
 * This report's seal, verified: the live-set fields it covers and the parsed recipe of the sealed
 * revision the two hashes were recomputed from (the same `revision` row, read once), or null. That is
 * everything `isLive` checks except the status word, so a paused report can be asked whether its
 * approval is still good. Never throws.
 *
 * @returns {Promise<{fields: object, recipe: object}|null>}
 */
async function verifiedLive(db, deps, report) {
  try {
    const d = resolveDeps(deps);
    if (report == null || typeof report !== "object") return null;
    const rev = Number(report.live_rev);
    if (!Number.isInteger(rev) || rev < 1) return null;
    if (typeof report.live_nonce !== "string" || !report.live_nonce) return null;
    if (typeof report.live_seal !== "string" || !report.live_seal) return null;
    if (typeof report.id !== "string" || !report.id) return null;
    const revision = await getRevision(db, report.id, rev);
    if (!revision) return null;
    const recipe = recipeOf(revision.recipe_json);
    const schedule = await d.getSchedule(db, report);
    if (!schedule || !text(schedule.cron)) return null;
    // The model is resolved now, never read from the row: a bot repointed at another provider, or a
    // provider repointed at another endpoint, must stop the report.
    const modelRef = await freshModelRef(db, d, report, revision);
    if (modelRef == null) return null;
    const seed = await seedOf(d);
    const fields = await liveSetFor(db, d, report, { modelRef });
    if (!verifyApprovalSeal("live", fields, report.live_seal, seed)) return null;
    return { fields, recipe };
  } catch {
    return null;
  }
}

/** The verified live-set fields alone, or null. Never throws. */
async function verifiedLiveSet(db, deps, report) {
  const verified = await verifiedLive(db, deps, report);
  return verified ? verified.fields : null;
}

/** Does this report's seal still verify, whatever its status says? Never throws. */
async function sealVerifies(db, deps, report) {
  return (await verifiedLive(db, deps, report)) !== null;
}

/**
 * The verified live set of a report that may run, or null. `null` means one of: not an object, not
 * `live`, or the seal does not verify over the row's current values (a direct UPDATE of a live-set
 * column or of the sealed revision, a schedule that stopped resolving, a model that resolves
 * differently now, no keychain seed). Never throws.
 *
 * When it is not null the answer is the live-set object the seal was verified over, spread out for the
 * reader (`rev`, `cron`, `tz`, `senderAccountId`, `deliveryMode`, ... `nonce`) and also under
 * `liveSet`, so a caller can hand exactly those fields back to `verifyApprovalSeal` without rebuilding
 * them, plus `recipe`: the parsed recipe of the revision those hashes came from (the sealed revision,
 * never the head), so a reader can see what the owner approved without re-reading the row.
 *
 * @param {object} db
 * @param {object} [deps]
 * @param {object|null} report a report row (or null)
 * @returns {Promise<object|null>} the verified live set, under `liveSet`, with `recipe`
 */
export async function verifyLive(db, deps, report) {
  try {
    if (!report || typeof report !== "object") return null;
    if (report.status !== REPORT_LIVE) return null;
    const verified = await verifiedLive(db, deps, report);
    if (!verified) return null;
    return { ...verified.fields, liveSet: verified.fields, recipe: verified.recipe };
  } catch {
    return null;
  }
}

/**
 * May this report run right now? `true` only when the status is `live` AND the seal verifies over the
 * row's current values of every live-set field, the revision row exists, the schedule resolves and the
 * model still resolves to the same provider, model, locality and endpoint. Never throws.
 *
 * @param {object} db
 * @param {object} [deps]
 * @param {object|null} report a report row (or null)
 * @returns {Promise<boolean>}
 */
export async function isLive(db, deps, report) {
  return !!(await verifyLive(db, deps, report));
}

/**
 * Re-seal a live report at a newer revision with a fresh nonce, in one write, and audit it.
 *
 * `verified` is the live set a `verifyLive` / `verifiedLiveSet` call just verified over this report's
 * row. Its fields are the seal's: the schedule, its zone, the sender, the bot, the project, the
 * artifact, the delivery rule, the comment defaults, the AI switch and the model are taken from THERE
 * and never read again, so a schedule row (or a model resolution) that moved between the verification
 * and this write cannot be sealed in. Only the revision, that revision's own recipe hash, the sources
 * hash and the fresh nonce are replaced.
 *
 * Before sealing, the revision being sealed is derived from its own `recipe_json` under this module's
 * block registry: its sources hash must equal the verified one and its model-call status must be the
 * sealed revision's, or the write is `go_live_needed` and nothing is written. A revision row whose text
 * and hash columns disagree is never blessed.
 */
async function restampLive(db, deps, report, rev, verified) {
  const d = resolveDeps(deps);
  if (verified == null || typeof verified !== "object") throw fail("go_live_needed");
  const revision = await getRevision(db, report.id, rev);
  if (!revision) throw fail("bad_recipe", "revision");
  const hashes = recomputedHashes(revision, d.registry);
  if (!hashes || hashes.sourcesHash !== text(verified.sourcesHash)) throw fail("go_live_needed");
  const sealedRevision = await getRevision(db, report.id, Number(verified.rev));
  if (!sealedRevision) throw fail("go_live_needed");
  if (callsModel(recipeOf(revision.recipe_json), report.ai_commentary)
    !== callsModel(recipeOf(sealedRevision.recipe_json), report.ai_commentary)) {
    throw fail("go_live_needed");
  }
  const seed = await seedOf(d);
  const nonce = newApprovalNonce();
  const fields = { ...verified, rev, recipeHash: hashes.recipeHash, sourcesHash: hashes.sourcesHash, nonce };
  const seal = approvalSeal("live", fields, seed);
  await updateReportColumns(db, report.id, {
    live_rev: rev,
    live_nonce: nonce,
    live_seal: seal,
    pending_free_change: 0,
  });
  await recordAudit(db, {
    reportId: report.id,
    kind: "live",
    subject: null,
    actor: "owner",
    decided: "approved",
    at: d.now(),
  });
}

/* --------------------------------------------------------------------------- go live */

/**
 * Approve a report to run: seal the live set over the head revision and make it `live`.
 *
 * The preview must be this report's, of the current head revision, and it must have finished `ok` or
 * `empty`. A schedule must resolve, the sender account must be ready, and a recipe that calls a model
 * must resolve one now (a null resolution is `model_unresolved`, never a guessed default). Nothing is
 * written until every check has passed, and the write is one UPDATE with the fresh nonce and seal.
 *
 * @param {object} db
 * @param {object} deps
 * @param {{reportId: string, previewRunId: string, actor: {kind: "owner"}}} input
 * @returns {Promise<{ok: true, liveRev: number}>}
 */
export async function approveGoLive(db, deps, { reportId, previewRunId, actor } = {}) {
  requireOwner(actor);
  const d = resolveDeps(deps);
  const report = await requireReport(db, reportId);

  if (typeof previewRunId !== "string" || !previewRunId) throw fail("preview_missing");
  const run = await d.getRun(db, previewRunId);
  if (!run || run.reportId !== report.id || run.kind !== "preview") throw fail("preview_missing");
  if (Number(run.recipeRev) !== Number(report.recipe_rev)) throw fail("preview_stale");
  if (run.status !== "ok" && run.status !== "empty") throw fail("preview_failed");

  const schedule = await d.getSchedule(db, report);
  if (!schedule || !text(schedule.cron)) throw fail("no_schedule");

  const accountId = text(report.sender_account_id);
  if (!accountId) throw fail("sender_not_ready");
  if ((await d.senderReady(db, accountId)) !== true) throw fail("sender_not_ready");

  const liveRev = Number(report.recipe_rev);
  const revision = Number.isInteger(liveRev) ? await getRevision(db, report.id, liveRev) : null;
  if (!revision) throw fail("bad_recipe", "revision");

  const modelRef = await freshModelRef(db, d, report, revision);
  if (modelRef == null) throw fail("model_unresolved");

  const seed = await seedOf(d);
  const nonce = newApprovalNonce();
  const fields = await liveSetFor(db, d, report, { rev: liveRev, nonce, modelRef });
  const seal = approvalSeal("live", fields, seed);

  await updateReportColumns(db, report.id, {
    status: REPORT_LIVE,
    live_rev: liveRev,
    live_nonce: nonce,
    live_seal: seal,
    approved_preview_run: previewRunId,
    model_ref: modelRef === "" ? null : modelRef,
    pause_reason: null,
    pending_free_change: 0,
  });
  await recordAudit(db, {
    reportId: report.id,
    kind: "live",
    subject: null,
    actor: "owner",
    decided: "approved",
    at: d.now(),
  });
  return { ok: true, liveRev };
}

/* ------------------------------------------------------------------ pause and resume */

/** The reason text a pause stores: one line, no control characters, scrubbed of secret values. */
function pauseReasonOf(reason, deps) {
  const raw = typeof reason === "string" ? reason : "";
  const flat = raw.replace(CONTROL_CHARS_ALL, " ").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  let secrets = [];
  try {
    secrets = deps.getSecrets() || [];
  } catch {
    secrets = [];
  }
  const redacted = redactSecrets(flat, secrets);
  return redacted.length > PAUSE_REASON_MAX ? redacted.slice(0, PAUSE_REASON_MAX) : redacted;
}

async function pauseOne(db, deps, { reportId, reason, actor }) {
  const d = resolveDeps(deps);
  const report = await requireReport(db, reportId);
  const updated = await updateReportColumns(db, report.id, {
    status: REPORT_PAUSED,
    pause_reason: pauseReasonOf(reason, d),
  });
  // A pause is a halt, not a refusal of the approval: the seal stays on the row so a resume can prove
  // that nothing moved in the meantime. The audit row says who halted it.
  await recordAudit(db, {
    reportId: report.id,
    kind: "live",
    subject: null,
    actor,
    decided: "refused",
    at: d.now(),
  });
  return updated;
}

/**
 * The owner's pause: the report stops, the seal stays for a resume, and the audit names the owner.
 *
 * @param {object} db
 * @param {object} deps
 * @param {{reportId: string, reason?: string, actor: {kind: "owner"}}} input
 * @returns {Promise<object>} the report row after the write
 */
export async function pauseReport(db, deps, { reportId, reason, actor } = {}) {
  requireOwner(actor);
  return pauseOne(db, deps, { reportId, reason, actor: "owner" });
}

/**
 * The system's pause, for a broken seal, a cap or a failed migration (PR 1b): same write, no actor,
 * audited as `system`. No owner check, and no way to go live: only `resumeReport` re-activates a
 * paused report, and that one is owner-only.
 *
 * @param {object} db
 * @param {object} deps
 * @param {{reportId: string, reason?: string}} input
 * @returns {Promise<object>} the report row after the write
 */
export async function pauseReportSystem(db, deps, { reportId, reason } = {}) {
  return pauseOne(db, deps, { reportId, reason, actor: "system" });
}

/**
 * The owner's resume: back to `live` only when the seal still verifies, which a pause does not touch.
 * A direct UPDATE of any live-set column while paused fails the seal, and the report stays paused with
 * `go_live_needed`.
 *
 * @param {object} db
 * @param {object} deps
 * @param {{reportId: string, actor: {kind: "owner"}}} input
 * @returns {Promise<object>} the report row after the write
 */
export async function resumeReport(db, deps, { reportId, actor } = {}) {
  requireOwner(actor);
  const d = resolveDeps(deps);
  const report = await requireReport(db, reportId);
  if (!(await sealVerifies(db, d, report))) throw fail("go_live_needed");
  const updated = await updateReportColumns(db, report.id, {
    status: REPORT_LIVE,
    pause_reason: null,
  });
  await recordAudit(db, {
    reportId: report.id,
    kind: "live",
    subject: null,
    actor: "owner",
    decided: "approved",
    at: d.now(),
  });
  return updated;
}

/* ------------------------------------------------------------------------- recipe saves */

/** The saved-head fields a caller is told about, whatever the save did to the seal. */
function savedAnswer(saved, { restamped = false, needsGoLive = false } = {}) {
  return {
    rev: saved.rev,
    hash: saved.hash,
    sourcesHash: saved.sourcesHash,
    restamped,
    needsGoLive,
  };
}

/**
 * The verified live set when a live report's approval is still good after a save, or null. Both hashes
 * and the model-call status. The live revision's hashes are recomputed from its own recipe text, the
 * way the seal computes them, and then compared with the sources hash the save just wrote (which
 * `saveRecipe` computed from the new recipe's text under the same registry).
 */
async function restampableLiveSet(db, deps, report, saved, newRecipe) {
  const d = resolveDeps(deps);
  if (report.status !== REPORT_LIVE) return null;
  const fields = await verifiedLiveSet(db, d, report);
  if (!fields) return null;
  const liveRevision = await getRevision(db, report.id, Number(report.live_rev));
  if (!liveRevision) return null;
  const liveHashes = recomputedHashes(liveRevision, d.registry);
  if (!liveHashes) return null;
  if (text(saved.sourcesHash) !== liveHashes.sourcesHash) return null;
  if (callsModel(newRecipe, report.ai_commentary)
    !== callsModel(recipeOf(liveRevision.recipe_json), report.ai_commentary)) return null;
  return fields;
}

/**
 * The owner's save (route `PUT /recipe`).
 *
 * The recipe is saved first — a refused recipe writes nothing. On a live report whose seal still
 * verifies, the seal is RE-STAMPED at the new revision only when nothing the owner approved moved: the
 * same sources hash and the same model-call status (a free change: a column, a sort, a filter). A save
 * that changed a source-bearing block, or a report whose seal was already broken, leaves the report on
 * its sealed revision and answers `needsGoLive`.
 *
 * @param {object} db
 * @param {object} deps
 * @param {{reportId: string, recipe: object, actor: {kind: "owner"}}} input
 * @returns {Promise<{rev: number, hash: string, sourcesHash: string, restamped: boolean,
 *   needsGoLive: boolean}>}
 */
export async function ownerSaveRecipe(db, deps, { reportId, recipe, actor } = {}) {
  requireOwner(actor);
  const d = resolveDeps(deps);
  const report = await requireReport(db, reportId);
  const saved = await saveRecipe(db, {
    reportId: report.id,
    recipe,
    authorKind: "owner",
    registry: d.registry,
  });
  const after = await getReport(db, report.id);
  if (!after) throw fail("not_found", "report");
  const verified = await restampableLiveSet(db, d, after, saved, recipe);
  if (!verified) {
    const live = after.status === REPORT_LIVE;
    return savedAnswer(saved, { needsGoLive: live });
  }
  await restampLive(db, d, after, saved.rev, verified);
  return savedAnswer(saved, { restamped: true });
}

/**
 * A bot's save (this path is used by PR 9a's bot tools). No actor, and no re-stamp ever: the seal
 * always means "the owner approved".
 *
 * The block registry is the server's own `deps.registry` and there is deliberately no way for a caller
 * to pass one: a caller that could pick the registry could have its own new source block counted as
 * free, land `pending_free_change` and reach the one-tap Apply below.
 *
 * On a live report whose seal still verifies, a save whose sources hash is unchanged marks
 * `pending_free_change`, so the owner's card can offer Apply (one tap) next to the automatic preview.
 * A save that moved the sources hash, or a report whose seal is already broken, leaves a head revision
 * only and answers `needsGoLive`.
 *
 * @param {object} db
 * @param {object} deps
 * @param {{reportId: string, recipe: object}} input
 * @returns {Promise<{rev: number, hash: string, sourcesHash: string, pendingFreeChange: boolean,
 *   needsGoLive: boolean}>}
 */
export async function botSaveRecipe(db, deps, { reportId, recipe } = {}) {
  const d = resolveDeps(deps);
  const report = await requireReport(db, reportId);
  const saved = await saveRecipe(db, {
    reportId: report.id,
    recipe,
    authorKind: "bot",
    registry: d.registry,
  });
  const after = await getReport(db, report.id);
  if (!after) throw fail("not_found", "report");

  if (after.status !== REPORT_LIVE) {
    return { ...saved, pendingFreeChange: false, needsGoLive: false };
  }
  if (!(await restampableLiveSet(db, d, after, saved, recipe))) {
    return { ...saved, pendingFreeChange: false, needsGoLive: true };
  }
  await updateReportColumns(db, report.id, { pending_free_change: 1 });
  return { ...saved, pendingFreeChange: true, needsGoLive: false };
}

/**
 * Apply a bot's free change with one owner tap: no fresh preview, no fresh go-live, because nothing the
 * owner approved moved.
 *
 * Requires `pending_free_change` on a live report, a seal that still verifies, a schedule that still
 * resolves, and a head revision whose own recipe text has the same sources hash and the same model-call
 * status as the sealed revision's. Anything else is `go_live_needed`, which is the card's prompt to run
 * a preview and go live properly.
 *
 * Both sides are read from the revision rows' own `recipe_json`, recomputed under the server's block
 * registry: the head hash columns are a cache, and neither a direct UPDATE of `reports.recipe_json`,
 * of `reports.sources_hash`, nor of a revision row may turn a source change into a free one.
 *
 * @param {object} db
 * @param {object} deps
 * @param {{reportId: string, actor: {kind: "owner"}}} input
 * @returns {Promise<{ok: true, liveRev: number}>}
 */
export async function applyPendingFreeChange(db, deps, { reportId, actor } = {}) {
  requireOwner(actor);
  const d = resolveDeps(deps);
  const report = await requireReport(db, reportId);
  if (Number(report.pending_free_change) !== 1) throw fail("bad_input", "pending_free_change");
  if (report.status !== REPORT_LIVE) throw fail("go_live_needed");
  const verified = await verifiedLiveSet(db, d, report);
  if (!verified) throw fail("go_live_needed");
  const headRev = Number(report.recipe_rev);
  if (!Number.isInteger(headRev) || headRev < 1) throw fail("go_live_needed");
  if (!(await getRevision(db, report.id, headRev))) throw fail("go_live_needed");
  // The re-stamp derives the head revision's own hashes and model-call status and refuses when either
  // moved, so nothing here has to trust the head columns.
  await restampLive(db, d, report, headRev, verified);
  return { ok: true, liveRev: headRev };
}

/* ---------------------------------------------------------------------------- settings */

/** One boolean-ish setting: 1/0, true/false. Anything else is not a value this Crow stores. */
function readFlag(value) {
  if (value === 1 || value === true) return 1;
  if (value === 0 || value === false) return 0;
  return null;
}

/**
 * The owner's settings write (route `PUT /settings`): the sender, the delivery rule, the comment
 * defaults, the AI switch, the title and the notify switch.
 *
 * An unknown key, a word outside an enum or a value of the wrong type is `bad_input` and writes
 * nothing. A sender that is not a send-ready Crow Mail account on this instance is `sender_not_ready`.
 * When a live report's sender, delivery, tier, visibility or AI switch actually changes, the report is
 * paused with the fixed sentence AND its seal and nonce are nulled in the same write: the live seal no
 * longer describes what the report would do, and setting the column back must not revive the old
 * approval. Only a fresh preview and go-live re-approve it (`resumeReport` answers `go_live_needed`).
 * The same change on a PAUSED report that still carries a seal nulls the seal and nonce as well, and
 * leaves its status and pause reason exactly as they were.
 *
 * @param {object} db
 * @param {object} deps
 * @param {{reportId: string, settings: object, actor: {kind: "owner"}}} input
 * @returns {Promise<object>} the report row after the write
 */
export async function updateSettings(db, deps, { reportId, settings, actor } = {}) {
  requireOwner(actor);
  const d = resolveDeps(deps);
  const report = await requireReport(db, reportId);
  if (settings == null || typeof settings !== "object" || Array.isArray(settings)) {
    throw fail("bad_input", "settings");
  }
  const keys = Object.keys(settings);
  if (!keys.length) throw fail("bad_input", "settings");

  const patch = {};
  for (const key of keys) {
    if (!REPORT_SETTING_KEYS.includes(key)) throw fail("bad_input", key);
    const value = settings[key];
    switch (key) {
      case "sender_account_id": {
        if (typeof value !== "string" || !value.trim()) throw fail("bad_input", key);
        const accountId = value.trim();
        if ((await d.senderReady(db, accountId)) !== true) throw fail("sender_not_ready");
        patch.sender_account_id = accountId;
        break;
      }
      case "delivery_mode":
        if (!DELIVERY_MODES.includes(value)) throw fail("bad_input", key);
        patch.delivery_mode = value;
        break;
      case "comment_tier_default":
        if (!COMMENT_TIERS.includes(value)) throw fail("bad_input", key);
        patch.comment_tier_default = value;
        break;
      case "comment_visibility":
        if (!COMMENT_VISIBILITIES.includes(value)) throw fail("bad_input", key);
        patch.comment_visibility = value;
        break;
      case "ai_commentary":
      case "notify_every_run": {
        const flag = readFlag(value);
        if (flag == null) throw fail("bad_input", key);
        patch[key] = flag;
        break;
      }
      case "title": {
        if (typeof value !== "string") throw fail("bad_input", key);
        const title = value.replace(CONTROL_CHARS_ALL, " ").replace(/\s+/g, " ").trim();
        if (!title || title.length > TITLE_MAX) throw fail("bad_input", key);
        patch.title = title;
        break;
      }
      default:
        throw fail("bad_input", key);
    }
  }

  const liveSetChanged = LIVE_SETTING_KEYS.some((key) => {
    if (!Object.hasOwn(patch, key)) return false;
    return key === "ai_commentary"
      ? flagNumber(patch[key]) !== flagNumber(report[key])
      : text(patch[key]) !== text(report[key]);
  });
  const liveChanged = report.status === REPORT_LIVE && liveSetChanged;
  // A pause keeps the seal so a resume can prove nothing moved while the report was stopped. A live-set
  // change while PAUSED therefore drops the seal too: the report is already paused, its status and its
  // pause reason stay as they are, but an owner who put the value back could otherwise resume onto an
  // approval that no longer describes the report.
  const pausedSealDropped = report.status === REPORT_PAUSED
    && liveSetChanged
    && typeof report.live_seal === "string" && report.live_seal !== "";
  if (liveChanged) {
    patch.status = REPORT_PAUSED;
    patch.pause_reason = SETTINGS_CHANGED_PAUSE_REASON;
    // The dropped seal is the point: without this, an owner who changed a live-set value and then put
    // it back could resume onto the old approval, which no longer describes what this report does.
    patch.live_seal = null;
    patch.live_nonce = null;
  } else if (pausedSealDropped) {
    patch.live_seal = null;
    patch.live_nonce = null;
  }

  const updated = await updateReportColumns(db, report.id, patch);
  if (liveChanged) {
    await recordAudit(db, {
      reportId: report.id,
      kind: "live",
      subject: null,
      actor: "owner",
      decided: "refused",
      at: d.now(),
    });
  }
  return updated;
}