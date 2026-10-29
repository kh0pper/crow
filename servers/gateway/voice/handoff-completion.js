/**
 * The completion notice (PR 5, Task 5.1): the "voice" result kind (board/result-requesters.js). When the bot
 * that took a hand-off reports its final result through board_report_result, the operator gets ONE
 * notification that opens what the bot made, the log row ends, the claim is released, and the bot's running
 * Perch turn keeps its "replied" push to itself [rv2 N2, rv3 C2]. Never imports handoff.js; handoff.js wires
 * it onto the core and registers it.
 *
 *   notice(cdb, ctx)   the hook result-service calls after the result insert; null hands back to today's
 *                      generic notice. ctx = { card, outcome, summaryMd, resultId, actor, tdb }
 *   owns(cdb, cardId)  the DB fallback [rv1 C7]: the card's newest hand-off row is open
 *   restore(cdb)       the card ids of the open rows, for the boot warm-up
 *
 * The notice carries a non-enumerable onSent(): the sender calls it once the notification was really sent, and only
 * then is the spoken heads-up announced (Task 5.2).
 *
 * Open means starting (with a card: P8), started, queued or quiet. A stopped, done or failed row is never
 * owned, so a stopped card's later result is an ordinary board result (5.4 relies on this).
 */
import { documentsForCard } from "../make/card-docs.js";
import { cardDrawerHref } from "../board/card-link.js";
import { markTurnEnd, releaseResult } from "../board/result-requesters.js";
import { voiceLine } from "./voice-lines.js";
import { botName, langOf } from "./handoff-confirm.js";

/** The statuses whose card result is this rail's (P8: a `starting` row counts once it has a card). */
export const COMPLETION_OPEN = Object.freeze(["starting", "started", "queued", "quiet"]);
const OPEN = new Set(COMPLETION_OPEN);
/** A document link the bot may have left in its summary, when the card has no document of its own [bc m9]. */
const ARTIFACT_URL = /\/dashboard\/artifacts\/view\/art_[A-Za-z0-9_-]{6,40}/;
const MAKE_URL = /\/dashboard\/make\/open\/(?:artifact|workspace_file)\/[A-Za-z0-9_%-]{1,64}/;
const DETAIL_MAX = 300;
const BODY_MAX = 140;

const noTable = (err) => /no such table/i.test(String(err?.message || err));
const cut = (s, max) => (s.length > max ? s.slice(0, max) : s);

/** The card id as a positive integer, or null. */
function cardIdOf(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * @param store     the hand-off store (handoff-store.js)
 * @param announce  the spoken heads-up seam (handoff-confirm.js announceHandoff → presence.announce) (P3)
 * @param cardHref  cardDrawerHref, the drawer link (null for a card that is not there)
 * @param docs      documentsForCard, a card's documents in its list order
 */
export function createHandoffCompletion({ store, announce, cardHref = cardDrawerHref, docs = documentsForCard, log = (m) => console.warn(m) } = {}) {
  if (!store || typeof announce !== "function") throw new Error("handoff-completion: a store and an announce are required");

  /** The card's newest hand-off row when it is open, else null. A crow.db without the log owns nothing. */
  async function openRow(cdb, cardId) {
    let row;
    try { row = await store.byCard(cdb, cardId); }
    catch (err) { if (noTable(err)) return null; throw err; }
    return row && row.kind === "handoff" && OPEN.has(row.status) ? row : null;
  }

  /**
   * Where the notification opens [bc m9]: the LAST of the card's documents (P5: hand links, then origin
   * artifacts by age, then chat artifacts, so the newest thing the bot made), else a document link in the
   * summary, else the card's drawer, else today's card link (P6).
   */
  async function actionUrl(cdb, cardId, summary, tdb) {
    try {
      const list = await docs(cdb, cardId);
      const last = Array.isArray(list) && list.length ? list[list.length - 1] : null;
      if (last && typeof last.openUrl === "string" && last.openUrl) return last.openUrl;
    } catch (err) { log(`[voice-handoff] card ${cardId}: documents could not be read (${err?.message || err})`); }
    const m = ARTIFACT_URL.exec(summary) || MAKE_URL.exec(summary);
    if (m) return m[0];
    let href = null;
    try { href = await cardHref(cdb, cardId, { tasksDb: tdb ?? null }); }
    catch (err) { log(`[voice-handoff] card ${cardId}: drawer link failed (${err?.message || err})`); }
    return href || "/dashboard/bot-board#card=" + cardId;
  }

  async function notice(cdb, ctx) {
    const cardId = cardIdOf(ctx?.card?.id);
    if (cardId == null) return null;
    const row = await openRow(cdb, cardId);
    if (!row) {
      // Not this rail's any more (stopped, ended, or never a hand-off): a stale claim is let go.
      releaseResult(cardId);
      return null;
    }
    // Only the target bot's OWN report ends the hand-off [rv1 C7]: an unattributed bot (id null) or anyone
    // else gets today's notice, and the row and the claim stay as they are. Checked before any write.
    const actor = ctx.actor;
    if (!actor || actor.kind !== "bot" || actor.id == null || actor.id !== row.bot_id) return null;
    const summary = typeof ctx.summaryMd === "string" ? ctx.summaryMd : "";
    const detail = cut(summary, DETAIL_MAX);
    // A partial report is progress, not an end [rv2 m6, P12]: the row keeps its status and the claim, the
    // detail says where the bot got to, and today's gated notice tells the operator.
    if (ctx.outcome === "partial") {
      await store.setFields(cdb, row.id, { detail });
      return null;
    }
    const to = ctx.outcome === "success" ? "done" : "failed";
    // A CAS: a stop or the sweep that landed first keeps its own ending and its own notice.
    if (!(await store.transition(cdb, row.id, COMPLETION_OPEN, to, { outcome: String(ctx.outcome), detail }))) return null;
    // Awaited while the reporting turn is still running (P4): its "replied" push would be a second notice.
    await markTurnEnd(cardId);
    const lang = langOf(row.lang);
    const vars = { bot: await botName(cdb, row.bot_id), task: row.task };
    const url = await actionUrl(cdb, cardId, summary, ctx.tdb);
    const spoken = to === "done" ? ["completion_spoken", "completion_spoken_kiosk"] : ["completion_failed_spoken", "completion_failed_spoken_kiosk"];
    releaseResult(cardId);
    const body = cut(summary, BODY_MAX);
    const out = {
      type: "attention", priority: "high", source: "crow-voice",
      title: voiceLine(to === "done" ? "completion_title_done" : "completion_title_failed", lang, vars),
      body: body || null,
      action_url: url,
    };
    // The spoken heads-up says "it's on your phone", so it goes only once the notification really went out: the
    // sender (result-service.js) calls onSent after a send that stored it, and never after one that failed or was
    // turned off (the 5.1 carry). Not enumerable: the notice itself stays a plain notification.
    Object.defineProperty(out, "onSent", {
      value: () => {
        Promise.resolve().then(() => announce({
          originDeviceId: row.device_id,
          handoffId: row.id,
          lineFor: (surface) => voiceLine(surface === "kiosk" ? spoken[1] : spoken[0], lang, vars),
        })).catch((err) => log(`[voice-handoff] ${row.id}: announce failed (${err?.message || err})`));
      },
    });
    return out;
  }

  async function owns(cdb, cardId) {
    const id = cardIdOf(cardId);
    return id != null && (await openRow(cdb, id)) != null;
  }

  async function restore(cdb) {
    let rows;
    try { rows = await store.openRows(cdb, { statuses: COMPLETION_OPEN, withCard: true }); }
    catch (err) { if (noTable(err)) return []; throw err; }
    return rows.map((r) => cardIdOf(r.card_id)).filter((id) => id != null);
  }

  return { notice, owns, restore };
}
