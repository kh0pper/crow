/**
 * Upload a render straight into a Funkwhale library, so fw_play can stream it
 * to the glasses or another speaker.
 *
 * Where the address and credential come from: ONLY the configuration the
 * gateway's own media relay uses (musicUpstreamConfig in
 * servers/gateway/media/pinned-upstream.js: the Funkwhale add-on's entry,
 * else the gateway environment). Nothing in a tool call can name a host, so a
 * tool call cannot point this request (or the token) anywhere else.
 *
 * Every request goes to that one origin, carries the token, never follows a
 * redirect (redirect: "error"), and has a timeout. A library is named by UUID
 * or by the exact name of one of the token owner's own libraries.
 */

import { createHash } from "node:crypto";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PUSH_FORMATS = Object.freeze(["mp3", "ogg"]);
export const RATE = Object.freeze({ toolId: "sunvox_funkwhale_upload", bucketKey: "global", capacity: 10, windowSeconds: 3600 });

function checkOrigin(origin) {
  let u;
  try { u = new URL(String(origin)); } catch { u = null; }
  if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.origin !== String(origin)) {
    throw new Error(`the configured Funkwhale address is not an http(s) origin: ${JSON.stringify(String(origin)).slice(0, 80)}`);
  }
  return u.origin;
}

async function call(fetchImpl, origin, token, pathAndQuery, { method = "GET", body, timeoutMs = 20_000, deadline = Infinity } = {}) {
  // Each request gets its own timeout, never past the push's overall deadline.
  const left = Math.min(timeoutMs, deadline - Date.now());
  if (!(left > 0)) throw new Error(`Funkwhale time budget used up before ${method} ${pathAndQuery.split("?")[0]}`);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), left);
  try {
    const res = await fetchImpl(origin + pathAndQuery, {
      method, body, redirect: "error", signal: ctl.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Funkwhale ${res.status} on ${method} ${pathAndQuery.split("?")[0]}: ${text.slice(0, 200)}`);
    try { return text ? JSON.parse(text) : {}; } catch { return {}; }
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Funkwhale request timed out: ${method} ${pathAndQuery.split("?")[0]}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveLibrary(fetchImpl, origin, token, library, deadline) {
  const want = String(library || "").trim();
  if (!want) throw new Error("funkwhale_library is empty: pass a library UUID or name (fw_list_library lists them)");
  if (UUID_RE.test(want)) return want.toLowerCase();
  const out = await call(fetchImpl, origin, token, "/api/v1/libraries/?scope=me&page_size=100", { timeoutMs: 10_000, deadline });
  const libs = Array.isArray(out?.results) ? out.results : [];
  const hit = libs.find((l) => typeof l?.name === "string" && l.name.toLowerCase() === want.toLowerCase());
  if (!hit || !UUID_RE.test(String(hit.uuid || ""))) {
    const names = libs.map((l) => l?.name).filter((n) => typeof n === "string").slice(0, 20);
    throw new Error(`no Funkwhale library named "${want.slice(0, 80)}"; your libraries: ${names.length ? names.join(", ") : "(none)"}`);
  }
  return String(hit.uuid).toLowerCase();
}

/**
 * → { funkwhale_library_uuid, funkwhale_upload_uuid, import_status, funkwhale_track_id? }
 * Waits up to pollTimeoutMs for the import to finish (best effort; Funkwhale
 * imports in the background).
 */
// Budgets: a gateway tool call times out after 60 s (the MCP client's
// default), and the render and encode already took part of that. So the whole
// push (lookup, upload, import checks) has one 35 s deadline that caps every
// request; the upload alone gets at most 30 s, each check at most 3 s.
export async function pushToFunkwhale({
  cfg, buf, fileName, library, fetchImpl = fetch, db = null, consumeToken = null,
  pollMs = 2000, pollTimeoutMs = 5000, uploadTimeoutMs = 30_000, totalMs = 35_000,
}) {
  const deadline = Date.now() + totalMs;
  if (!cfg || !cfg.origin || !cfg.token) {
    throw new Error("the Funkwhale add-on is not installed or not configured (it needs FUNKWHALE_URL and FUNKWHALE_ACCESS_TOKEN); the render is saved, upload it later with fw_upload_track");
  }
  const ext = String(fileName).split(".").pop().toLowerCase();
  if (!PUSH_FORMATS.includes(ext)) throw new Error(`Funkwhale uploads take mp3 or ogg; render with format "mp3" (got ${ext})`);
  const origin = checkOrigin(cfg.origin);
  if (consumeToken) {
    // No database, no budget check: refuse rather than upload unmetered.
    if (!db) throw new Error("the Funkwhale upload rate limit needs the Crow database, which is not available");
    const r = await consumeToken(db, RATE);
    if (!r.allowed) throw new Error(`Funkwhale upload rate limit reached (${RATE.capacity} per hour); try again in ${r.retry_after} s`);
  }
  const libUuid = await resolveLibrary(fetchImpl, origin, cfg.token, library, deadline);
  const form = new FormData();
  form.append("library", libUuid);
  // The content hash: a retried call for the same render carries the same reference.
  form.append("import_reference", `sunvox-studio-${createHash("sha256").update(buf).digest("hex").slice(0, 16)}`);
  form.append("audio_file", new Blob([buf], { type: ext === "mp3" ? "audio/mpeg" : "audio/ogg" }), String(fileName).slice(0, 200));
  const up = await call(fetchImpl, origin, cfg.token, "/api/v1/uploads/", { method: "POST", body: form, timeoutMs: uploadTimeoutMs, deadline });
  const upUuid = UUID_RE.test(String(up?.uuid || "")) ? String(up.uuid).toLowerCase() : null;
  const out = { funkwhale_library_uuid: libUuid, funkwhale_upload_uuid: upUuid, import_status: typeof up?.import_status === "string" ? up.import_status : null };
  if (!upUuid) return out;
  const pollUntil = Math.min(Date.now() + pollTimeoutMs, deadline);
  let status = up;
  while (status?.import_status !== "finished" && status?.import_status !== "errored" && Date.now() + pollMs < pollUntil) {
    await new Promise((r) => setTimeout(r, pollMs));
    try { status = await call(fetchImpl, origin, cfg.token, `/api/v1/uploads/${upUuid}/`, { timeoutMs: 3000, deadline: pollUntil }); } catch { break; }
  }
  if (typeof status?.import_status === "string") out.import_status = status.import_status;
  if (out.import_status === "errored") {
    out.import_error = JSON.stringify(status?.import_details ?? status?.import_metadata ?? null).slice(0, 300);
  } else if (out.import_status !== "finished") {
    out.note = "Funkwhale is still importing the file; find it with fw_search (type tracks) in a moment, then fw_play it";
  }
  const trackId = status?.track?.id ?? (typeof status?.track === "number" ? status.track : null);
  if (Number.isInteger(trackId)) out.funkwhale_track_id = trackId;
  return out;
}
