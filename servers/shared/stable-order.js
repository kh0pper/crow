/**
 * Deterministic order for tool surfaces (queue item 35).
 *
 * Some serving engines render the tool block before the system message and
 * cache it across conversations, so the same set of tools must serialize to
 * the same bytes on every boot and every turn. The gateway's connectedServers
 * Map fills in connect-COMPLETION order (built-in integrations connect in
 * parallel; an uninstall + install appends), so its iteration order is not a
 * stable property — callers that turn it into a tools array sort through here.
 */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** [id, entry] pairs of a Map (or any iterable of pairs), ordered by id. */
export function sortedServers(servers) {
  return [...servers].sort(([a], [b]) => byCodeUnit(String(a), String(b)));
}

/** Tool definitions ordered by name; returns a copy, never mutates the input. */
export function sortedByName(list) {
  return [...(list || [])].sort((a, b) => byCodeUnit(String(a?.name ?? ""), String(b?.name ?? "")));
}
