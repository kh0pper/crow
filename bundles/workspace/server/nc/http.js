import { WsError } from "../result.js";

// Methods that are safe to send twice (RFC 9110 idempotent + the read-only WebDAV methods). POST, MOVE, MKCOL,
// PROPPATCH and LOCK are never resent.
const RESENDABLE = new Set(["GET", "HEAD", "OPTIONS", "PROPFIND", "REPORT", "SEARCH", "PUT", "DELETE"]);
// A pooled keep-alive socket the server already closed: fetch reuses it and the request dies with a reset. This
// happens after the event loop was busy past the server's keep-alive timeout (a long repeat expansion, say), so
// the client never saw the close in time. Refused connections and timeouts are real outages and are not retried.
const STALE_SOCKET = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);
const staleSocket = (e) => e?.name !== "TimeoutError" && STALE_SOCKET.has(e?.cause?.code);

export async function ncFetch(cfg, method, url, { headers = {}, body, timeoutMs = 30000 } = {}) {
  const send = () => fetch(url, {
    method, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.appPassword}`).toString("base64")}`, "OCS-APIRequest": "true", ...headers },
  });
  try {
    try { return await send(); }
    catch (e) {
      // one resend, on a fresh connection, for a method that may be sent twice (a conditional PUT that did land
      // the first time answers 412 → changed_concurrently, never a silent double write)
      if (!staleSocket(e) || !RESENDABLE.has(method)) throw e;
      return await send();
    }
  } catch (e) {
    throw new WsError("workspace_unreachable", `Crow Workspace did not answer (${e?.name === "TimeoutError" ? "timed out" : "connection failed"}). Is it running?`);
  }
}

export async function readCapped(res, maxBytes) {
  const len = Number(res.headers.get("content-length") || 0);
  if (len > maxBytes) { res.body?.cancel?.(); throw new WsError("too_large", `The file is ${(len / 1048576).toFixed(1)} MB; the limit is ${(maxBytes / 1048576).toFixed(0)} MB`); }
  const chunks = []; let total = 0;
  for await (const c of res.body) { total += c.length; if (total > maxBytes) throw new WsError("too_large", `The file is larger than ${(maxBytes / 1048576).toFixed(0)} MB`); chunks.push(c); }
  return new Uint8Array(Buffer.concat(chunks));
}

export function httpFail(res, what) {
  const map = { 401: ["not_ready", "Crow bot's Workspace app password was rejected; re-run Workspace setup"], 403: ["forbidden", `Crow bot is not allowed to ${what}`], 404: ["not_found", `Not found while trying to ${what}`], 409: ["conflict", `The parent folder does not exist (${what})`], 412: ["changed_concurrently", `Someone changed it first (${what})`], 423: ["locked", `It is locked (${what})`], 507: ["quota", "The Workspace is out of space"] };
  const [code, msg] = map[res.status] || ["workspace_error", `Workspace answered HTTP ${res.status} while trying to ${what}`];
  return new WsError(code, msg);
}
