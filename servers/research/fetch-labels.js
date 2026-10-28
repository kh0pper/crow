/**
 * The one source of truth for how a source's fetch status and quote check count read.
 * The research tools (list/get/bibliography tags) and the Projects panel both import
 * this, so they cannot disagree. The tools return these English strings to bots; the
 * panel keys its Spanish strings off the same status CODES (FETCH_STATUS_CODES).
 */

export const FETCH_STATUS_LABEL = Object.freeze({
  fetched: "fetched",
  fetched_no_text: "fetched (no text)",
  failed: "failed",
  legacy: "legacy, unchecked",
  not_applicable: "not a web page",
});
/** What a NULL (peer-synced or cloned) or unrecognized status reads as. */
export const UNFETCHED_LABEL = "not fetched here";

/** The label for a fetch_status; NULL or anything unrecognized reads as "not fetched here". */
export const statusLabel = (st) => FETCH_STATUS_LABEL[st] || UNFETCHED_LABEL;

/** The status code the panel keys its translation off ("unknown" for NULL/unrecognized). */
export const statusCode = (st) => (FETCH_STATUS_LABEL[st] ? st : "unknown");

/** "2/3 quotes found" */
export const quotesLabel = (found, total) => `${Number(found || 0)}/${Number(total || 0)} quotes found`;
