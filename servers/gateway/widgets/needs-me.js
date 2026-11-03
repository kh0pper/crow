/**
 * "What needs me" (widgets phase 1, spec §7.1–§7.2) — the ONE server summary both the in-Crow
 * widget and the Android home-screen widget draw. JSON only, never HTML.
 *
 * The summary merges three sources, in this order:
 *
 *   board     the Board's own Needs-you lane, through For You's process cache (needsLaneCached:
 *             one Board read per process per 45 s, shared with the morning card — no second read).
 *             A needs-you card is a decision (an open `data_json.decision`, lanes.js's openDecision),
 *             a result awaiting a decision (`latest_result_status === "recorded"`, the same state
 *             kindOf calls a review), or a plan to approve (the card's current plan record is still a
 *             draft — plan-service's getCurrentPlan, the Board's own "current plan" rule). A card that
 *             is only an `action_needed` question is in the lane but is no kind this widget offers, so
 *             it is left for the full Board list behind more_href.
 *   handoffs  voice hand-offs waiting on the phone (status awaiting_phone, not past expires_at).
 *   messages  message threads whose NEWEST message is inbound and unread.
 *
 * Rules this file owns (Global Constraints):
 *   - a plan NEVER gets actions (the operator's ruling, 2026-11-03): approving a bot's plan always opens the card;
 *   - inline actions exist only for a decision's own options when there are at most
 *     MAX_INLINE_OPTIONS of them and every label fits MAX_INLINE_LABEL, for a result
 *     (Accept / Not now) and for a hand-off (Yes / No);
 *   - the `lock` block carries a count and a neutral label ONLY — never a title, a name or a project.
 *
 * Every action is stateless-safe: each item carries a `nonce` (itemNonce) over the state the action
 * was drawn from, so the act route can refuse a tap made against a changed item with 409 stale and
 * send the operator a fresh summary instead of acting twice.
 *
 * The read never throws: a source that fails costs its own lines, never the summary.
 */
import { createHash } from "node:crypto";

import { TASKS_DB, lockMapFor } from "../dashboard/panels/bot-board/data-queries.js";
import { laneRows, defsFor, cardsByIds } from "../dashboard/panels/board.js";
import { groupByLane, openDecision } from "../dashboard/panels/board/lanes.js";
import { drawerHref, drawerHrefs } from "../board/card-link.js";
import { getCurrentPlan } from "../board/plan-service.js";
import { createHandoffStore } from "../voice/handoff-store.js";
import { needsLaneCached } from "../for-you/morning.js";
import { contactName } from "../../sharing/contact-display.js";
import { t, fill } from "../dashboard/shared/i18n.js";

/** The widget shows this many items; the full list is behind more_href. */
export const NEEDS_ME_MAX = 5;
/** A decision keeps its options on the widget only when there are at most this many. */
export const MAX_INLINE_OPTIONS = 3;
/** …and only when every label fits this (a decision with longer options opens the card). */
export const MAX_INLINE_LABEL = 24;
/** "Your bots are working on" lists at most this many card titles. */
const DOING_MAX = 3;
/** The full list the summary links to. */
export const MORE_HREF = "/dashboard/bot-board";

const ABSENT_RE = /no such (table|column)/i;

const oneLine = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * The item's version stamp: the first 16 hex chars of sha256 over `{kind, id, status, updated_at,
 * version}` in that order. Stateless (nothing is stored): an action carries the nonce it was drawn
 * with, and the act route recomputes it from the item as it is now — a changed status, timestamp or
 * version is a different nonce, and the tap is refused as stale.
 */
export function itemNonce(parts = {}) {
  const p = parts || {};
  const body = JSON.stringify({
    kind: p.kind ?? null,
    id: p.id ?? null,
    status: p.status ?? null,
    updated_at: p.updated_at ?? null,
    version: p.version ?? null,
  });
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/** data_json as an object (absent or malformed is {}). */
function dataOf(card) {
  let data = card?.data_json;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return {}; }
  }
  return data && typeof data === "object" ? data : {};
}

/**
 * A decision card's options as inline actions, or [] when it must open the card: more than
 * MAX_INLINE_OPTIONS, or any label longer than MAX_INLINE_LABEL (or empty). The recommended option
 * is primary (the Board's own rule: it is always first); the rest are plain.
 */
export function decisionActions(card) {
  const options = dataOf(card).decision?.options;
  if (!Array.isArray(options) || options.length === 0 || options.length > MAX_INLINE_OPTIONS) return [];
  const labels = options.map((o) => oneLine(o?.label));
  if (labels.some((l) => !l || l.length > MAX_INLINE_LABEL)) return [];
  const recommended = options.findIndex((o) => o?.recommended === true);
  const primary = recommended >= 0 ? recommended : 0;
  return labels.map((label, index) => ({
    id: `option:${index}`,
    label,
    style: index === primary ? "primary" : "plain",
  }));
}

/** One board card as an item, or null for a needs-you card this widget has no kind for. */
async function boardItem(tdb, card, { links, projectName, lang }) {
  const id = Number(card.id);
  const base = {
    title: oneLine(card.title) || t("forYou.untitled", lang),
    project: card.project_id == null ? null : projectName(Number(card.project_id)),
    href: links.get(id) || drawerHref(id, null),
  };
  if (openDecision(card)) {
    return {
      key: `card:${id}:decision`, kind: "decision", ...base,
      nonce: itemNonce({ kind: "decision", id, status: card.status, updated_at: card.updated_at, version: null }),
      actions: decisionActions(card),
    };
  }
  if (card.latest_result_status === "recorded" && card.latest_result_id != null) {
    const resultId = Number(card.latest_result_id);
    return {
      key: `card:${id}:result:${resultId}`, kind: "result", ...base,
      nonce: itemNonce({ kind: "result", id, status: card.status, updated_at: card.updated_at, version: resultId }),
      actions: [
        { id: "accept", label: t("widgets.needsMe.accept", lang), style: "primary" },
        { id: "not_now", label: t("widgets.needsMe.notNow", lang), style: "plain" },
      ],
    };
  }
  let plan = null;
  try { plan = await getCurrentPlan(tdb, id); }
  catch (err) { if (!ABSENT_RE.test(String(err && err.message))) throw err; }
  if (plan && String(plan.status) === "draft") {
    return {
      key: `card:${id}:plan:${plan.version}`, kind: "plan", ...base,
      nonce: itemNonce({ kind: "plan", id, status: card.status, updated_at: card.updated_at, version: plan.version }),
      // Plans NEVER get actions: approving one always opens the card (the operator's ruling, 2026-11-03).
      actions: [],
    };
  }
  return null;
}

/**
 * The Board's Needs-you lane, in the Board's own rank, as items. The lane comes through For You's
 * cache, which carries the lane's total and its first NEEDS_LINES cards (morning.js), so the board
 * source contributes at most that many items — the whole list is one tap away on more_href.
 */
async function boardItems(db, tdb, projects, key, lang) {
  const lane = await needsLaneCached(db, tdb, key);
  const cards = (lane && lane.cards) || [];
  if (!cards.length) return [];
  let links = new Map();
  try { links = await drawerHrefs(db, cards, { tasksDb: tdb }); }
  catch (err) { console.warn("[needs-me] card links failed:", err && err.message); }
  const byId = new Map(projects.map((p) => [Number(p.id), String(p.name)]));
  const projectName = (pid) => byId.get(pid) ?? null;
  const out = [];
  for (const card of cards) {
    const item = await boardItem(tdb, card, { links, projectName, lang });
    if (item) out.push(item);
  }
  return out;
}

/** Voice hand-offs waiting on the phone: not expired, newest first (the store's order). */
async function handoffItems(db, store, now, lang) {
  const rows = await store.openRows(db, { statuses: ["awaiting_phone"] });
  return (rows || [])
    .filter((r) => r.expires_at == null || Number(r.expires_at) > now)
    .map((r) => ({
      key: `handoff:${r.id}`,
      kind: "handoff",
      title: oneLine(r.task),
      project: null,
      href: `/dashboard/voice/handoffs/${encodeURIComponent(String(r.id))}`,
      nonce: itemNonce({ kind: "handoff", id: r.id, status: r.status, updated_at: r.updated_at, version: null }),
      actions: [
        { id: "yes", label: t("widgets.needsMe.yes", lang), style: "primary" },
        { id: "no", label: t("widgets.needsMe.no", lang), style: "plain" },
      ],
    }));
}

/**
 * Message threads whose newest message is inbound and unread ("unanswered", spec §7.2), newest
 * thread first. Deep-link only: no inline actions.
 */
async function messageItems(db, lang) {
  const { rows } = await db.execute({
    sql: `SELECT m.id AS message_id, m.contact_id AS contact_id, m.created_at AS created_at,
                 m.direction AS direction, m.is_read AS is_read,
                 c.display_name AS display_name, c.peer_display_name AS peer_display_name, c.crow_id AS crow_id
            FROM messages m
            JOIN contacts c ON c.id = m.contact_id
           WHERE m.id = (SELECT MAX(m2.id) FROM messages m2 WHERE m2.contact_id = m.contact_id)
             AND m.direction = 'received' AND COALESCE(m.is_read, 0) = 0
           ORDER BY m.created_at DESC, m.id DESC`,
    args: [],
  });
  return (rows || []).map((r) => {
    const contactId = Number(r.contact_id);
    return {
      key: `message:${contactId}`,
      kind: "message",
      title: oneLine(contactName(r, { fallback: r.crow_id ? String(r.crow_id) : String(contactId) })) || t("messages.pageTitle", lang),
      project: null,
      href: `/dashboard/messages#peer-${contactId}`,
      nonce: itemNonce({ kind: "message", id: contactId, status: "received", updated_at: r.created_at, version: Number(r.message_id) }),
      actions: [],
    };
  });
}

/** What the bots are working on, for the all-clear state: the Board's in-progress lane, ≤ DOING_MAX titles. */
async function doingTitles(db, tdb) {
  const rows = await laneRows(tdb, { all: true });
  const lockMap = await lockMapFor(db, rows.map((r) => r.id));
  const defs = await defsFor(tdb, rows);
  const working = groupByLane(rows, defs, lockMap).working.slice(0, DOING_MAX);
  if (!working.length) return [];
  const full = await cardsByIds(tdb, working.map((r) => r.id));
  return working.map((r) => oneLine(full.get(r.id)?.title)).filter(Boolean);
}

/** True when a snooze entry for `key` has not yet run out. */
function isSnoozed(snoozed, key, now) {
  const until = snoozed && Object.hasOwn(snoozed, key) ? Number(snoozed[key]) : NaN;
  return Number.isFinite(until) && until > now;
}

/**
 * Everything the widget draws. `db` is crow.db, `tdb` an open tasks.db client (or null when there is
 * no store). `now` (ms) is the clock (expiry, snoozes, updated_at); `projects` are the live project
 * rows ({ id, slug, name }) the lane's key and names come from; `handoffStore` and `snoozed` are
 * injectable for tests. Items are ordered board rank → hand-offs → messages (newest first within
 * each), snoozed keys are left out, and the list is capped at NEEDS_ME_MAX — while `lock.count` is
 * the whole waiting count.
 *
 * @returns {Promise<{id: string, title: string, updated_at: string, state: "ok"|"empty"|"error",
 *   headline: string, items: object[], more_href: string, lock: {count: number, label: string},
 *   doing: string[]}>}
 */
export async function loadNeedsMe(db, tdb, {
  now = Date.now(),
  projects = [],
  handoffStore,
  snoozed = {},
  lang = "en",
  tasksDbPath = TASKS_DB,
} = {}) {
  const list = Array.isArray(projects) ? projects : [];
  const store = handoffStore || createHandoffStore();
  let failed = 0;

  let board = [];
  if (tdb) {
    const key = `${tasksDbPath}|${[...new Set(list.map((p) => Number(p.id)))].sort((a, b) => a - b).join(",")}`;
    try { board = await boardItems(db, tdb, list, key, lang); }
    catch (err) { failed++; console.warn("[needs-me] board read failed:", err && err.message); }
  } else {
    failed++;
  }

  let handoffs = [];
  try { handoffs = await handoffItems(db, store, Number(now), lang); }
  catch (err) { failed++; console.warn("[needs-me] hand-off read failed:", err && err.message); }

  let messages = [];
  try { messages = await messageItems(db, lang); }
  catch (err) { failed++; console.warn("[needs-me] message read failed:", err && err.message); }

  const waiting = [...board, ...handoffs, ...messages].filter((it) => !isSnoozed(snoozed, it.key, now));
  const items = waiting.slice(0, NEEDS_ME_MAX);

  let state = items.length ? "ok" : "empty";
  let headline = state === "empty" ? t("widgets.needsMe.allClear", lang) : fill(t("widgets.needsMe.waiting", lang), { n: waiting.length });
  if (!items.length && failed >= 3) {
    // Every source failed: say so instead of claiming all clear.
    state = "error";
    headline = "";
  }

  let doing = [];
  if (state === "empty" && tdb) {
    try { doing = await doingTitles(db, tdb); }
    catch (err) { console.warn("[needs-me] what bots are doing failed:", err && err.message); }
  }

  return {
    id: "needs-me",
    title: t("widgets.needsMe.title", lang),
    updated_at: new Date(Number(now)).toISOString(),
    state,
    headline,
    items,
    more_href: MORE_HREF,
    // The ONLY thing a locked phone may draw: a count and a neutral label (no titles, names or projects).
    lock: { count: waiting.length, label: fill(t("widgets.needsMe.waiting", lang), { n: waiting.length }) },
    doing,
  };
}