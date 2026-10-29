/**
 * The session-summary memory source (R1.2 PR 4): one memory per summarised
 * Perch session, keyed `session-summary:<originInstanceId>:<threadId>`.
 *
 * The prefix is RESERVED: only the summary job (servers/gateway/perch/
 * session-summary.js) writes a memory with it. crow_store_memory refuses it,
 * crow_update_memory and the memory panel refuse to edit such a memory, and a
 * contact share import renames it. Each summary memory is single-writer: only
 * its origin instance (the one in the source) writes it, and instance sync
 * accepts an insert or update for it only from that origin
 * (instance-sync.js _applySummaryMemory). Deletes are accepted from anyone.
 *
 * Pure and import-free on purpose.
 */
export const SUMMARY_SOURCE_PREFIX = "session-summary:";

/** True for any source in the reserved namespace (old or new form). */
export function isSummaryMemorySource(source) {
  return typeof source === "string" && source.startsWith(SUMMARY_SOURCE_PREFIX) && source.length > SUMMARY_SOURCE_PREFIX.length;
}

/** The source for one session: session-summary:<origin>:<threadId>. */
export function summarySource(originInstanceId, threadId) {
  const origin = String(originInstanceId || ""), thread = String(threadId || "");
  if (!origin || !thread || origin.includes(":") || thread.includes(":")) throw new Error("summarySource: bad id");
  return SUMMARY_SOURCE_PREFIX + origin + ":" + thread;
}

/** { origin, threadId } for a well-formed source, else null (the old one-part form is null). */
export function parseSummarySource(source) {
  if (!isSummaryMemorySource(source)) return null;
  const rest = source.slice(SUMMARY_SOURCE_PREFIX.length);
  const i = rest.indexOf(":");
  if (i <= 0 || i === rest.length - 1 || rest.indexOf(":", i + 1) !== -1) return null;
  return { origin: rest.slice(0, i), threadId: rest.slice(i + 1) };
}

/** The refusal message for a write that is not the summary job's. */
export const SUMMARY_SOURCE_RESERVED =
  "This memory is a session summary: only the session summary job writes it. Use Forget on the session to remove it.";

/** A contact share import's source: a reserved one is renamed ("shared:" + it), never imported as a summary. */
export function importedShareSource(raw) {
  const s = typeof raw === "string" ? raw : "";
  return isSummaryMemorySource(s) ? "shared:" + s : s;
}
