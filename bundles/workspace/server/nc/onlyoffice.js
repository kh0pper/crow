import { createHmac } from "node:crypto";
import { WsError } from "../result.js";
import { ocsGet } from "./ocs.js";
import { ncFetch, readCapped, httpFail } from "./http.js";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export function signJwt(payload, secret) { const h = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`; return `${h}.${createHmac("sha256", secret).update(h).digest("base64url")}`; }

export async function ooCommand(cfg, payload) {
  if (!cfg.jwtSecret) throw new WsError("not_ready", "The document editor's secret is missing from Workspace setup");
  const token = signJwt(payload, cfg.jwtSecret);
  let r;
  try { r = await fetch(`${cfg.ooUrl}/coauthoring/CommandService.ashx`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...payload, token }), signal: AbortSignal.timeout(15000) }); }
  catch { throw new WsError("editor_unreachable", "The document editor did not answer"); }
  if (!r.ok) throw new WsError("editor_unreachable", `The document editor answered HTTP ${r.status}`);
  // A non-JSON body (proxy error page…) must not surface as a SyntaxError quoting that body.
  try { return await r.json(); } catch { throw new WsError("editor_unreachable", "The document editor gave an unreadable answer"); }
}

/** The editor session for a file: key, whether it is live, raw users ("<instanceid>_<uid>", spike S6) and bare uids. */
export async function docSession(cfg, fileId) {
  const c = await ocsGet(cfg, `/ocs/v2.php/apps/onlyoffice/api/v1/config/${Number(fileId)}`);
  const key = c?.document?.key;
  if (!key) throw new WsError("editor_unreachable", "Could not read the editor's document key");
  // The connector names crow-bot "<instanceid>_crow-bot"; that prefix is stripped from every session user.
  const own = String(c?.editorConfig?.user?.id || "");
  const suffix = `_${cfg.user}`;
  const prefix = own.endsWith(suffix) ? own.slice(0, -suffix.length) : "";
  const info = await ooCommand(cfg, { c: "info", key });
  const users = Array.isArray(info.users) ? info.users.map(String) : [];
  return { key, live: info.error === 0, users, uids: users.map((u) => (prefix && u.startsWith(`${prefix}_`) ? u.slice(prefix.length + 1) : u)) };
}

export async function dropUsers(cfg, key, users) {
  const r = await ooCommand(cfg, { c: "drop", key, users });
  if (r.error !== 0) throw new WsError("could_not_close_editor", "The editor would not close the session; try again later.");
}

export async function exportAs(cfg, fileId, ext, maxBytes) {
  const r = await ncFetch(cfg, "GET", `${cfg.ncUrl}/apps/onlyoffice/downloadas?fileId=${Number(fileId)}&toExtension=${encodeURIComponent(ext)}`, { timeoutMs: 180000 });
  if (!r.ok) throw httpFail(r, `convert it to ${ext}`);
  return readCapped(r, maxBytes);
}
