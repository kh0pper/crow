/**
 * Decision service — decision cards on the Bot Board.
 *
 * A decision card is an ordinary card whose `data_json.decision` carries a
 * question, 2–4 options (exactly one recommended, placed first, each with a
 * stated consequence) and some bookkeeping. Answering records the choice on
 * the card, optionally creates ONE gated follow-up card, and closes the card.
 * Design: the private engineering notes (decision cards).
 *
 * Shape of `data_json.decision`:
 *   { question, context_md, fingerprint, batch, options: [...], expires,
 *     chosen?: {index, label, value, other_text, decided_at},
 *     created_card_id?, expired_at?, notified_at? }
 *
 * Rules this file owns:
 *   - Re-ask suppression: an open card with the same fingerprint is returned
 *     instead of a new one; so is a decided one whose chosen option carried
 *     `snooze_days` that have not yet passed.
 *   - At most MAX_OPEN_PER_BATCH open decision cards per batch.
 *   - One answer per card: the "not yet decided" check and the write of
 *     `chosen` are one conditional UPDATE, so a double tap or two tabs
 *     produce exactly one decision and one follow-up card.
 *   - One push per card: notifyBatch claims each card's `notified_at` with a
 *     conditional UPDATE before pushing.
 *
 * Every data_json write is a json_set merge on `$.decision…`, never a
 * whole-column overwrite, so other writers' keys survive.
 *
 * "Open" = has a decision, not archived, no `chosen`, no `expired_at`, and a
 * non-terminal status on its board. Fingerprints and batches are scoped to the
 * whole tasks.db (decision cards are instance-wide asks).
 *
 * Errors use card-service's `{code, http}` idiom. `now` (ms or Date) is
 * injectable for tests everywhere time matters; default Date.now().
 */

import { createCard, getCard, moveCard, recordMutation } from "./card-service.js";
import { resolveBoardDef, isTerminal } from "../routes/board-defs.js";
import { hasArchivedAtColumn } from "./util.js";

export const MAX_OPEN_PER_BATCH = 5;
const DAY_MS = 86400000;
const DEFAULT_EXPIRY_DAYS = 7;
// board_mutations.actor_kind is CHECKed to human/session/bot; expiry is no
// one's action, so it records as an unattended session with a fixed id.
const EXPIRY_ACTOR = Object.freeze({ kind: "session", id: "decision-expiry", jobId: null });

function fail(msg, code, http) {
  return Object.assign(new Error(msg), { code, http });
}

function toMs(now) {
  if (now == null) return Date.now();
  if (now instanceof Date) return now.getTime();
  return Number(now);
}

// ---- validation ----

function bad(msg) {
  return fail(msg, "bad_decision", 400);
}

function reqStr(v, name, max) {
  if (typeof v !== "string") throw bad(`${name} must be a string`);
  const s = v.trim();
  if (!s) throw bad(`${name} is required`);
  if (s.length > max) throw bad(`${name} must be at most ${max} characters`);
  return s;
}

function optStr(v, name, max) {
  if (v == null) return null;
  if (typeof v !== "string") throw bad(`${name} must be a string`);
  if (v.length > max) throw bad(`${name} must be at most ${max} characters`);
  const s = v.trim();
  return s || null;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date "YYYY-MM-DD" (rejects 2026-02-31). */
function isCalendarDate(s) {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

/**
 * The instant a decision stops being answerable. A date-only `expires` lasts
 * through that whole day (UTC); a full ISO timestamp is exact.
 */
function expiryMs(expires) {
  const s = String(expires ?? "");
  if (isCalendarDate(s)) return Date.parse(`${s}T00:00:00Z`) + DAY_MS;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : Infinity;
}

function validateOption(o, i) {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw bad(`options[${i}] must be an object`);
  const out = {
    label: reqStr(o.label, `options[${i}].label`, 120),
    consequence: reqStr(o.consequence, `options[${i}].consequence`, 240),
    recommended: false,
    value: optStr(o.value, `options[${i}].value`, 200),
  };
  if (o.recommended != null) {
    if (typeof o.recommended !== "boolean") throw bad(`options[${i}].recommended must be a boolean`);
    out.recommended = o.recommended;
  }
  if (o.snooze_days != null) {
    if (!Number.isInteger(o.snooze_days) || o.snooze_days < 0 || o.snooze_days > 90) {
      throw bad(`options[${i}].snooze_days must be an integer 0-90`);
    }
    out.snooze_days = o.snooze_days;
  }
  if (o.then != null) {
    if (typeof o.then !== "object" || Array.isArray(o.then)) throw bad(`options[${i}].then must be an object`);
    const cc = o.then.create_card;
    if (cc != null) {
      if (typeof cc !== "object" || Array.isArray(cc)) throw bad(`options[${i}].then.create_card must be an object`);
      out.then = {
        create_card: {
          title: reqStr(cc.title, `options[${i}].then.create_card.title`, 300),
          description: optStr(cc.description, `options[${i}].then.create_card.description`, 20000),
          owner: optStr(cc.owner, `options[${i}].then.create_card.owner`, 60),
          assign_bot: optStr(cc.assign_bot, `options[${i}].then.create_card.assign_bot`, 100),
        },
      };
    }
  }
  return out;
}

/**
 * Validate and normalize a decision payload. Throws {code:"bad_decision",
 * http:400}. `now` only feeds the default `expires` (today+7, UTC date).
 */
export function validateDecision(d, { now } = {}) {
  if (!d || typeof d !== "object" || Array.isArray(d)) throw bad("decision must be an object");
  const question = reqStr(d.question, "question", 300);
  const context_md = optStr(d.context_md, "context_md", 20000) ?? "";
  const fingerprint = reqStr(d.fingerprint, "fingerprint", 200);
  const batch = reqStr(d.batch, "batch", 100);

  if (!Array.isArray(d.options) || d.options.length < 2 || d.options.length > 4) {
    throw bad("options must be an array of 2-4 options");
  }
  const options = d.options.map(validateOption);
  const recommended = options.filter((o) => o.recommended).length;
  if (recommended !== 1) throw bad("exactly one option must be recommended");
  if (!options[0].recommended) throw bad("the recommended option must be first");

  let expires;
  if (d.expires == null || d.expires === "") {
    expires = new Date(toMs(now) + DEFAULT_EXPIRY_DAYS * DAY_MS).toISOString().slice(0, 10);
  } else {
    if (typeof d.expires !== "string") throw bad("expires must be an ISO date");
    const s = d.expires.trim();
    const ok = DATE_RE.test(s) ? isCalendarDate(s) : (/^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(Date.parse(s)));
    if (!ok) throw bad("expires must be an ISO date");
    expires = s;
  }

  return { question, context_md, fingerprint, batch, options, expires };
}

// ---- reads ----

function parseDecision(row) {
  try {
    const d = JSON.parse(row.data_json || "{}").decision;
    return d && typeof d === "object" ? d : null;
  } catch {
    return null;
  }
}

/** Per-call cache of project_id → board def. */
function defCache(tdb) {
  const m = new Map();
  return (projectId) => {
    const k = projectId == null ? "null" : String(projectId);
    if (!m.has(k)) m.set(k, resolveBoardDef(tdb, { projectId: projectId == null ? null : Number(projectId) }));
    return m.get(k);
  };
}

/**
 * Decision cards matching an optional fingerprint/batch filter, split by
 * state. `open` excludes terminal-status cards; `decided` = has `chosen`.
 */
async function findDecisionCards(tdb, { fingerprint, batch, decided = false } = {}) {
  const where = [
    "board_id IS NULL",
    "json_extract(data_json,'$.decision') IS NOT NULL",
    decided ? "json_extract(data_json,'$.decision.chosen') IS NOT NULL"
            : "json_extract(data_json,'$.decision.chosen') IS NULL AND json_extract(data_json,'$.decision.expired_at') IS NULL",
  ];
  const args = [];
  if (await hasArchivedAtColumn(tdb)) where.push("archived_at IS NULL");
  if (fingerprint != null) { where.push("json_extract(data_json,'$.decision.fingerprint')=?"); args.push(fingerprint); }
  if (batch != null) { where.push("json_extract(data_json,'$.decision.batch')=?"); args.push(batch); }
  const { rows } = await tdb.execute({
    sql: `SELECT id, project_id, status, data_json FROM tasks_items WHERE ${where.join(" AND ")} ORDER BY id ASC`,
    args,
  });
  if (decided) return rows.map((r) => ({ row: r, decision: parseDecision(r) })).filter((x) => x.decision);

  const defFor = defCache(tdb);
  const out = [];
  for (const r of rows) {
    const decision = parseDecision(r);
    if (!decision) continue;
    const def = await defFor(r.project_id);
    if (isTerminal(def, String(r.status))) continue;
    out.push({ row: r, decision });
  }
  return out;
}

/** The terminal status to close a card into: `preferred` if terminal, else the first terminal. */
function closeStatus(def, preferred) {
  if (def.terminal_values.includes(preferred)) return preferred;
  return def.terminal_values[0] ?? null;
}

// ---- writes ----

/**
 * Open decision cards past `expires` get `decision.expired_at` and move to
 * `cancelled` (or the board's first terminal value). Returns the count.
 * `actor` is optional (defaults to EXPIRY_ACTOR).
 */
export async function expireDecisions(tdb, cdb, now, actor = EXPIRY_ACTOR) {
  const ms = toMs(now);
  const stamp = new Date(ms).toISOString();
  const open = await findDecisionCards(tdb);
  const defFor = defCache(tdb);
  let count = 0;
  for (const { row, decision } of open) {
    if (ms < expiryMs(decision.expires)) continue;
    const id = Number(row.id);
    const r = await tdb.execute({
      sql: `UPDATE tasks_items SET data_json=json_set(data_json,'$.decision.expired_at',?), updated_at=datetime('now')
            WHERE id=? AND board_id IS NULL
              AND json_extract(data_json,'$.decision.chosen') IS NULL
              AND json_extract(data_json,'$.decision.expired_at') IS NULL`,
      args: [stamp, id],
    });
    if (r.rowsAffected !== 1) continue;
    count++;
    await recordMutation(tdb, { itemId: id, verb: "decision_expire", actor, detail: { expired_at: [null, stamp] } });
    const target = closeStatus(await defFor(row.project_id), "cancelled");
    if (target && target !== String(row.status)) {
      try {
        await moveCard(tdb, cdb, id, target, actor);
      } catch {
        // A held lock keeps the status as is; expired_at already closes the decision.
      }
    }
  }
  return count;
}

/**
 * Ask a decision. Returns {id, deduped}. Throws bad_decision (400) or
 * batch_full (429). `now` is for tests.
 */
export async function askDecision(tdb, cdb, { projectId, title, tags, decision } = {}, actor, { now } = {}) {
  const ms = toMs(now);
  const v = validateDecision(decision, { now: ms });
  await expireDecisions(tdb, cdb, ms);

  const sameOpen = await findDecisionCards(tdb, { fingerprint: v.fingerprint });
  if (sameOpen.length) return { id: Number(sameOpen[0].row.id), deduped: true };

  const sameDecided = await findDecisionCards(tdb, { fingerprint: v.fingerprint, decided: true });
  for (const { row, decision: d } of sameDecided.reverse()) {
    const c = d.chosen;
    const opt = c && Number.isInteger(c.index) && c.index >= 0 ? d.options?.[c.index] : null;
    const days = opt?.snooze_days;
    if (!Number.isInteger(days) || days <= 0) continue;
    const at = Date.parse(c.decided_at);
    if (Number.isFinite(at) && at + days * DAY_MS > ms) return { id: Number(row.id), deduped: true };
  }

  const inBatch = await findDecisionCards(tdb, { batch: v.batch });
  if (inBatch.length >= MAX_OPEN_PER_BATCH) {
    throw fail(`batch already has ${MAX_OPEN_PER_BATCH} open decisions`, "batch_full", 429);
  }

  const { id } = await createCard(tdb, {
    title: title != null && String(title).trim() ? String(title) : v.question,
    tags: tags ?? null,
    project_id: projectId ?? null,
  }, actor);
  await tdb.execute({
    sql: "UPDATE tasks_items SET data_json=json_set(data_json,'$.decision',json(?)) WHERE id=? AND board_id IS NULL",
    args: [JSON.stringify(v), id],
  });
  await recordMutation(tdb, { itemId: id, verb: "decision_ask", actor, detail: { fingerprint: v.fingerprint, batch: v.batch } });
  return { id, deduped: false };
}

/**
 * Answer a decision card. `index` picks an option; `-1` is "Other…" and needs
 * `otherText` (1–2000). `isEnabledBot(botId) -> Promise<boolean>` is injected
 * (production: `(id) => isEnabledBot(cdb, id)` from bot-lookup.js).
 * Returns {chosen, created_card_id}.
 */
export async function decideOption(tdb, cdb, itemId, { index, otherText } = {}, actor, { isEnabledBot, now } = {}) {
  const ms = toMs(now);
  const card = await getCard(tdb, itemId);
  const d = card ? parseDecision(card) : null;
  if (!card || !d) throw fail("decision card not found", "not_found", 404);
  if (card.archived_at != null) throw fail("card is archived", "archived", 409);
  if (d.chosen) throw fail("decision already made", "already_decided", 409);
  if (d.expired_at || ms >= expiryMs(d.expires)) throw fail("decision has expired", "expired", 409);
  const def = await resolveBoardDef(tdb, { projectId: card.project_id == null ? null : Number(card.project_id) });
  if (isTerminal(def, String(card.status))) throw fail("decision card is closed", "closed", 409);

  const options = Array.isArray(d.options) ? d.options : [];
  let opt = null;
  let other = null;
  if (index === -1) {
    if (typeof otherText !== "string" || !otherText.trim() || otherText.length > 2000) {
      throw fail("Other needs a 1-2000 character answer", "bad_option", 400);
    }
    other = otherText.trim();
  } else if (Number.isInteger(index) && index >= 0 && index < options.length) {
    opt = options[index];
  } else {
    throw fail("no such option", "bad_option", 400);
  }

  const chosen = {
    index,
    label: opt ? opt.label : "Other",
    value: opt ? (opt.value ?? null) : null,
    other_text: other,
    decided_at: new Date(ms).toISOString(),
  };
  const w = await tdb.execute({
    sql: `UPDATE tasks_items SET data_json=json_set(data_json,'$.decision.chosen',json(?)), updated_at=datetime('now')
          WHERE id=? AND board_id IS NULL AND json_extract(data_json,'$.decision.chosen') IS NULL`,
    args: [JSON.stringify(chosen), itemId],
  });
  if (w.rowsAffected !== 1) throw fail("decision already made", "already_decided", 409);

  let created = null;
  const cc = opt?.then?.create_card;
  if (cc) {
    const bot = cc.assign_bot || null;
    const enabled = bot && typeof isEnabledBot === "function" ? !!(await isEnabledBot(bot)) : false;
    const r = await createCard(tdb, {
      title: cc.title,
      description: cc.description ?? null,
      project_id: card.project_id == null ? null : Number(card.project_id),
      autonomy: "gated",
      assigned_bot: enabled ? bot : null,
      owner: bot && !enabled ? (cc.owner ?? bot) : (cc.owner ?? null),
    }, actor);
    created = r.id;
    await tdb.execute({
      sql: "UPDATE tasks_items SET data_json=json_set(data_json,'$.decision.created_card_id',?) WHERE id=? AND board_id IS NULL",
      args: [created, itemId],
    });
  }

  await recordMutation(tdb, { itemId, verb: "decision", actor, detail: { chosen, created_card_id: created } });

  const target = closeStatus(def, "done");
  if (target && target !== String(card.status)) await moveCard(tdb, cdb, itemId, target, actor);

  return { chosen, created_card_id: created };
}

/**
 * One grouped push for a batch's not-yet-notified open decisions. Each card is
 * claimed (notified_at set) by a conditional UPDATE before the push, so
 * repeated or concurrent calls push each card at most once.
 * `createNotification(cdb, opts)` is injected (servers/shared/notifications.js
 * in production).
 */
export async function notifyBatch(tdb, cdb, batch, { createNotification, now } = {}) {
  const ms = toMs(now);
  const stamp = new Date(ms).toISOString();
  const open = (await findDecisionCards(tdb, { batch: String(batch ?? "") }))
    .filter(({ decision }) => !decision.notified_at && ms < expiryMs(decision.expires));

  const claimed = [];
  for (const { row, decision } of open) {
    const r = await tdb.execute({
      sql: `UPDATE tasks_items SET data_json=json_set(data_json,'$.decision.notified_at',?)
            WHERE id=? AND board_id IS NULL AND json_extract(data_json,'$.decision.notified_at') IS NULL`,
      args: [stamp, Number(row.id)],
    });
    if (r.rowsAffected === 1) claimed.push({ id: Number(row.id), question: String(decision.question ?? "") });
  }
  if (!claimed.length) return { pushed: false, count: 0 };

  const count = claimed.length;
  await createNotification(cdb, {
    type: "attention",
    priority: "normal",
    title: `${count} decision${count > 1 ? "s" : ""} waiting`,
    body: claimed.slice(0, 3).map((c) => c.question).join("\n"),
    action_url: "/dashboard/bot-board#card=" + claimed[0].id,
  });
  return { pushed: true, count };
}
