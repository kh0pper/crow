/**
 * Crow Artifacts → board card (plan Task 3.4, D4 "Create a board card").
 *
 * A TRUSTED round the bot has no live clean session for — or that hit capacity
 * and whose owner chose the card — becomes a GATED board card: the round
 * message is saved as the card's PLAN (a dispatch prompt reads the plan
 * records), so the bot job that picks the card up gets exactly the snapshot
 * text and nothing else. Untrusted rounds never come here (v1: card jobs have
 * no locked-narrowing path).
 *
 * Actor: the same shape as bot-board-api's DASHBOARD_ACTOR — the card is made
 * by the owner's own click, on their behalf.
 */
import { createDbClient } from "../../db.js";
import { tasksDbPath as defaultTasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
import { createCard } from "./card-service.js";
import { savePlan } from "./plan-service.js";

const OWNER_ACTOR = { kind: "human", id: null, jobId: null };

/**
 * @param {object} o
 * @param {object} o.db  crow.db client (the artifact title lookup)
 * @param {() => string} [o.tasksDbPath]  test seam
 * @returns {(args: { round: object, text: string }) => Promise<number>}
 *   the createBoardCard seam deliverRound() takes; resolves to the card id.
 */
export function makeArtifactBoardCard({ db, tasksDbPath = defaultTasksDbPath } = {}) {
  return async function createBoardCard({ round, text }) {
    const kindWord = round && round.kind === "ask" ? "question" : "round";
    let title = `Artifacts ${kindWord} ${round ? round.id : "?"}`;
    try {
      const r = (await db.execute({ sql: "SELECT title FROM artifacts WHERE id=?", args: [round.artifact_id] })).rows[0];
      if (r && r.title) title = `Artifacts ${kindWord} ${round.id}: ${r.title}`;
    } catch { /* a title lookup must never fail the card */ }
    const tdb = createDbClient(tasksDbPath());
    try {
      const card = await createCard(tdb, {
        title: String(title).slice(0, 300),
        description: "Crow Artifacts feedback — the plan carries the round message.",
        tags: "artifacts",
        // autonomy stays the default "gated": the job needs the owner's go
        // like any other card, and the round's snapshot lives in the plan.
      }, OWNER_ACTOR);
      const cardId = Number(card.id);
      await savePlan(tdb, cardId, String(text), OWNER_ACTOR);
      return cardId;
    } finally {
      try { tdb.close(); } catch {}
    }
  };
}
