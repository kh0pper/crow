import { WsError } from "../result.js";

export async function ncFetch(cfg, method, url, { headers = {}, body, timeoutMs = 30000 } = {}) {
  try {
    return await fetch(url, {
      method, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.appPassword}`).toString("base64")}`, "OCS-APIRequest": "true", ...headers },
    });
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
