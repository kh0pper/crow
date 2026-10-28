/**
 * The "N need you" text, alone in an i18n-only module so the shell chrome can
 * label a count without importing the Board's data layer (needs-you.js pulls in
 * routes/perch.js, board.js and the engine). needs-you.js re-exports it.
 */
import { t } from "../../shared/i18n.js";

/** The "N need you" text for a count: null for 0, "?" for unknown (callers add the screen-reader text). */
export function needsYouLabel(n, lang = "en") {
  if (n === null || n === undefined) return "?";
  if (!n) return null;
  return t(n === 1 ? "shell.needYouOne" : "shell.needYou", lang).replace("{n}", String(n));
}
