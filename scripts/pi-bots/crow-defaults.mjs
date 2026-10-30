/**
 * Crow defaults: a short fixed block every bot turn gets, after the bot's own
 * system prompt (2026-10-29, operator feedback). Bots kept ignoring the
 * operator's writing rules unless reminded, never offered to track follow-ups
 * on the project board, kept tasks in memory notes, and once reported "the
 * board is organized" after writing project notes instead of cards.
 *
 * The writing rules are the operator's own `writing_style` section of crow.md
 * (crow_context, global row). The board lines appear only when the turn can
 * actually use the board (the def grants the board server).
 */
import Database from "better-sqlite3";
import { botsDbPath, resolveSqlitePath } from "./instance-paths.mjs";

/** Upper bound on the writing rules carried into a prompt. */
export const WRITING_RULES_MAX = 6000;

/**
 * The operator's global writing rules (crow_context section `writing_style`,
 * no device or project scope, enabled), or "" when there are none. Never throws.
 */
export function readWritingRules(dbPath = botsDbPath()) {
  let d;
  try {
    d = new Database(resolveSqlitePath(dbPath), { readonly: true, fileMustExist: true });
    d.pragma("busy_timeout = 5000");
    const r = d.prepare(
      "SELECT content FROM crow_context WHERE section_key='writing_style' AND device_id IS NULL AND project_id IS NULL AND COALESCE(enabled,1)=1 ORDER BY id LIMIT 1",
    ).get();
    const text = r && typeof r.content === "string" ? r.content.trim() : "";
    return text.length > WRITING_RULES_MAX ? text.slice(0, WRITING_RULES_MAX) : text;
  } catch {
    return "";
  } finally {
    try { d && d.close(); } catch { /* closed */ }
  }
}

/**
 * The block's text. `boardOn`: the turn has the board tools.
 * @param {{writingRules?: string, boardOn?: boolean}} opts
 */
export function crowDefaultsBlock({ writingRules = "", boardOn = false } = {}) {
  const lines = ["# Crow defaults (always apply)"];
  if (writingRules) {
    lines.push("", "Follow the operator's writing rules below in everything you write for them (replies, drafts, emails, documents, cards), without being asked.", "", "<writing-rules>", writingRules, "</writing-rules>");
  }
  if (boardOn) {
    lines.push(
      "",
      "Board habits:",
      "- When work leaves follow-ups, decisions or things waiting on someone, offer to put them on this project's board as cards (board_create_item). Track tasks as board cards, not memory notes or project notes.",
      "- Keep cards current as work moves (board_move_item, board_update_item).",
    );
  }
  lines.push(
    "",
    "Honesty about actions:",
    "- Never say something is done, saved, sent, booked or on the board unless a tool call in this turn actually did it and succeeded. If a tool failed or you used a different tool than asked, say so plainly.",
  );
  return lines.join("\n");
}
