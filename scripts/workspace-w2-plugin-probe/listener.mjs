#!/usr/bin/env node
// W2 spike S9: loopback listener for the ONLYOFFICE plugin probe (probe.js), reached through the temporary
// tailnet Serve path https://<host>:8457/crow-live/probe -> http://127.0.0.1:3399.
//
//   node listener.mjs --setup   "<scratch dir>"                    MKCOL + upload rich.* as probe.{docx,xlsx,pptx}
//   node listener.mjs --serve   "<scratch dir>" --out <facts.json> listen on 127.0.0.1:3399 until SIGTERM/SIGINT
//   node listener.mjs --cleanup "<scratch dir>"                    move the scratch dir to the trash (idempotent)
//   node listener.mjs --check-saved "<scratch dir>"                does the saved probe.docx contain CROW-PROBE?
//   node listener.mjs --parent                                     print "Shared with Crow/<first folder>" (as the spike picks it)
//
// Secrets: reads ~/.crow/bundles/workspace/.env through the bundle codec. It verifies the plugin's token (HS256,
// WORKSPACE_ONLYOFFICE_JWT_SECRET) and records claim NAMES only (+ document.key, exp, iat, user id/name and a few
// non-secret view-mode markers). It never writes or prints the token, the secret, or any other .env value.
import { readFileSync, writeFileSync, renameSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { parseEnvText } from "../../servers/gateway/bundle-env-codec.js";

const REPO = join(import.meta.dirname, "..", "..");
const NC = "http://127.0.0.1:3070", OO = "http://127.0.0.1:3071", U = "crow-bot";
const HOST = "127.0.0.1", PORT = 3399;
const EXT_BY_EDITOR = { word: "docx", cell: "xlsx", slide: "pptx" };

const argv = process.argv.slice(2);
const mode = argv[0];
const DIR = argv[1];
const outIdx = argv.indexOf("--out");
const OUT = outIdx > 0 ? argv[outIdx + 1] : null;
if (!["--setup", "--serve", "--cleanup", "--check-saved", "--parent"].includes(mode) || (mode !== "--parent" && !DIR)) {
  console.error("usage: listener.mjs --setup|--serve|--cleanup|--check-saved \"Shared with Crow/<folder>/W2 probe <ts>\" [--out facts.json] | --parent");
  process.exit(2);
}
// Guard: this tool only ever touches its own scratch folder.
if (mode !== "--parent" && !/^Shared with Crow\/[^/]+\/W2 probe \d+$/.test(DIR)) { console.error(`refusing: not a W2 probe scratch dir: ${DIR}`); process.exit(2); }

let env;
const loadEnv = () => {
  if (!env) env = parseEnvText(readFileSync(join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "workspace", ".env"), "utf8"));
  return env;
};
const AUTH = () => "Basic " + Buffer.from(`${U}:${loadEnv().WORKSPACE_BOT_APP_PASSWORD}`).toString("base64");
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const dav = (method, path, { headers = {}, body } = {}) => fetch(`${NC}/remote.php/dav/${path}`, { method, headers: { Authorization: AUTH(), ...headers }, body });
const unesc = (v) => v == null ? v : v.replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const prop = (xml, name) => unesc((xml.match(new RegExp(`<${name}>([^<]*)<`)) || [])[1] ?? null);
const PF = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:prop><d:getetag/><oc:fileid/><nc:lock/><nc:lock-owner-type/><nc:lock-owner/></d:prop></d:propfind>`;
const stat = async (p) => {
  const r = await dav("PROPFIND", `files/${U}/${enc(p)}`, { headers: { Depth: "0" }, body: PF });
  const x = await r.text();
  return { status: r.status, fileid: Number(prop(x, "oc:fileid")), lock: prop(x, "nc:lock"), lockType: prop(x, "nc:lock-owner-type"), lockOwner: prop(x, "nc:lock-owner") };
};
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const signJwt = (payload) => { const h = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u(payload)}`; return `${h}.${createHmac("sha256", loadEnv().WORKSPACE_ONLYOFFICE_JWT_SECRET).update(h).digest("base64url")}`; };
// Same shape as the spike's cmd(): the command service, authenticated with the shared ONLYOFFICE secret.
const cmd = async (payload) => { const t = signJwt(payload); return (await fetch(`${OO}/coauthoring/CommandService.ashx`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: JSON.stringify({ ...payload, token: t }) })).json(); };
const ocsKey = async (fileid) => {
  const r = await fetch(`${NC}/ocs/v2.php/apps/onlyoffice/api/v1/config/${fileid}?format=json`, { headers: { Authorization: AUTH(), "OCS-APIRequest": "true" } });
  const j = await r.json().catch(() => null);
  return j?.document?.key ?? null; // only the key is kept; the rest of the config (signed URLs, token) is dropped here
};

// ---------- parent / setup / cleanup / check-saved ----------
if (mode === "--parent") {
  const list = await (await dav("PROPFIND", `files/${U}/Shared%20with%20Crow/`, { headers: { Depth: "1" } })).text();
  const m = list.match(/<d:href>\/remote\.php\/dav\/files\/crow-bot\/Shared%20with%20Crow\/([^<\/]+)\/<\/d:href>/);
  if (!m) { console.error("no folder under 'Shared with Crow' for crow-bot"); process.exit(1); }
  console.log(`Shared with Crow/${decodeURIComponent(m[1])}`);
  process.exit(0);
}
if (mode === "--check-saved") {
  const r = await dav("GET", `files/${U}/${enc(`${DIR}/probe.docx`)}`);
  if (r.status !== 200) { console.log(`CROW-PROBE in saved probe.docx: unknown (GET ${r.status})`); process.exit(1); }
  const d = mkdtempSync(join(tmpdir(), "w2-probe-")); const f = join(d, "probe.docx");
  try {
    writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    const n = (execFileSync("unzip", ["-p", f, "word/document.xml"]).toString().match(/CROW-PROBE/g) || []).length;
    console.log(`CROW-PROBE in saved probe.docx: ${n > 0} (occurrences: ${n})`);
  } finally { rmSync(d, { recursive: true, force: true }); }
  process.exit(0);
}
if (mode === "--setup") {
  const mk = await dav("MKCOL", `files/${U}/${enc(DIR)}`);
  console.log(`MKCOL ${mk.status}`);
  if (mk.status !== 201) process.exit(1);
  for (const ext of ["docx", "xlsx", "pptx"]) {
    const body = readFileSync(join(REPO, "tests", "fixtures", "workspace", `rich.${ext}`));
    const r = await dav("PUT", `files/${U}/${enc(`${DIR}/probe.${ext}`)}`, { body });
    console.log(`PUT probe.${ext} ${r.status}`);
    if (r.status >= 300) process.exit(1);
  }
  process.exit(0);
}
if (mode === "--cleanup") {
  const r = await dav("DELETE", `files/${U}/${enc(DIR)}`);
  const gone = (await dav("PROPFIND", `files/${U}/${enc(DIR)}`, { headers: { Depth: "0" } })).status === 404;
  console.log(`scratch DELETE ${r.status}; gone: ${gone}`);
  process.exit(gone ? 0 : 1);
}

// ---------- serve ----------
const facts = { started_at: new Date().toISOString(), scratch_dir: DIR, sessions: {}, marks: [], summary: {} };
const persist = () => {
  if (!OUT) return;
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, JSON.stringify(facts, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, OUT);
};
const log = (s) => console.log(`[probe ${new Date().toISOString().slice(11, 19)}] ${s}`);

// Claim paths (names only), depth-first; arrays are summarised as "<path>[]".
const claimPaths = (o, pre = "", out = []) => {
  for (const [k, v] of Object.entries(o || {})) {
    const p = pre ? `${pre}.${k}` : k;
    if (Array.isArray(v)) out.push(`${p}[]`);
    else if (v && typeof v === "object") { out.push(p); claimPaths(v, p, out); }
    else out.push(p);
  }
  return out;
};
const getPath = (o, p) => p.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
// Non-secret values worth comparing between the laptop (edit) and phone (view) tokens.
const VIEW_MARKER = /(^|\.)(mode|type)$|(^|\.)permissions\.[A-Za-z]+$|(^|\.)(isViewMode|view|readonly|readOnly)$/;
const viewMarkers = (payload) => {
  const out = {};
  for (const p of claimPaths(payload)) {
    if (!VIEW_MARKER.test(p)) continue;
    const v = getPath(payload, p);
    if (typeof v === "boolean" || typeof v === "number" || (typeof v === "string" && v.length <= 20 && !/[./:]/.test(v))) out[p] = v;
  }
  return out;
};

// Verify HS256; returns { valid, alg, payload } — the token itself is never stored.
const verify = (token) => {
  if (typeof token !== "string" || token.split(".").length !== 3) return { valid: false, alg: null, payload: null, reason: "not a JWT" };
  const [h, p, s] = token.split(".");
  let header, payload;
  try { header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")); payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")); }
  catch { return { valid: false, alg: null, payload: null, reason: "undecodable" }; }
  if (header.alg !== "HS256") return { valid: false, alg: header.alg ?? null, payload, reason: `alg ${header.alg} not verified` };
  const want = createHmac("sha256", loadEnv().WORKSPACE_ONLYOFFICE_JWT_SECRET).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, "base64url");
  const valid = got.length === want.length && timingSafeEqual(got, want);
  return { valid, alg: "HS256", payload, reason: valid ? null : "signature did not verify with WORKSPACE_ONLYOFFICE_JWT_SECRET (the docservice may use a different secret on this install)" };
};

const USER_ID_PATHS = ["editorConfig.user.id", "user.id", "document.user.id", "userid", "userId"];
const USER_NAME_PATHS = ["editorConfig.user.name", "user.name", "document.user.name", "username", "userName"];
const KEY_PATHS = ["document.key", "key", "payload.document.key"];
const first = (payload, paths) => { for (const p of paths) { const v = getPath(payload, p); if (v != null && typeof v !== "object") return { path: p, value: v }; } return { path: null, value: null }; };

const session = (id) => (facts.sessions[id] ??= { ticks: [] });

async function onInit(b) {
  const s = session(b.session);
  Object.assign(s, { at: new Date(b.t || Date.now()).toISOString(), editorType: b.editorType ?? null, isViewMode: b.isViewMode ?? null, isMobileMode: b.isMobileMode ?? null, plugin_userId: b.userId ?? null, plugin_userName: b.userName ?? null, documentId: b.documentId ?? null, infoKeys: Array.isArray(b.infoKeys) ? b.infoKeys : null });
  s.has_jwt = typeof b.jwt === "string" && b.jwt.length > 0;
  const v = s.has_jwt ? verify(b.jwt) : { valid: false, alg: null, payload: null, reason: "no jwt in plugin info" };
  delete b.jwt; // drop the token: nothing below may see it
  s.jwt_signature_valid = v.valid; s.jwt_alg = v.alg; if (v.reason) s.jwt_note = v.reason;
  if (v.payload) {
    const pl = v.payload;
    s.claim_names = claimPaths(pl);
    const key = first(pl, KEY_PATHS); s.token_document_key = key.value; s.token_document_key_path = key.path;
    s.exp = typeof pl.exp === "number" ? pl.exp : null; s.iat = typeof pl.iat === "number" ? pl.iat : null;
    s.lifetime_s = s.exp != null && s.iat != null ? s.exp - s.iat : null;
    s.token_kind = s.lifetime_s == null ? "unknown (no exp/iat)" : s.lifetime_s >= 86400 ? "docservice_session (lifetime >= 1 day)" : s.lifetime_s <= 600 ? "editor_config (lifetime <= 10 min)" : "other";
    const uid = first(pl, USER_ID_PATHS), uname = first(pl, USER_NAME_PATHS);
    s.token_user_id = uid.value; s.token_user_id_path = uid.path; s.token_user_name = uname.value;
    s.view_markers = viewMarkers(pl);
  }
  s.documentId_equals_token_key = s.documentId != null && s.token_document_key != null ? String(s.documentId) === String(s.token_document_key) : null;
  // OCS config key for the scratch file of this editor type
  const ext = EXT_BY_EDITOR[s.editorType];
  if (ext) {
    try { const st = await stat(`${DIR}/probe.${ext}`); s.ocs_key_matches_documentId = String(await ocsKey(st.fileid)) === String(s.documentId); }
    catch (e) { s.ocs_key_matches_documentId = `error: ${e.message}`; }
  }
  // Is the token's user in the live session (command service info)?
  try {
    await new Promise((r) => setTimeout(r, 2000));
    const info = await cmd({ c: "info", key: String(s.documentId) });
    const users = Array.isArray(info?.users) ? info.users.map(String) : null;
    s.info_response = { error: info?.error ?? null, users };
    s.info_users_contains_token_user = users && s.token_user_id != null ? users.includes(String(s.token_user_id)) : null;
    s.info_users_contains_plugin_user = users && s.plugin_userId != null ? users.includes(String(s.plugin_userId)) : null;
  } catch (e) { s.info_response = { error: `request failed: ${e.message}` }; }
  log(`init ${s.editorType} view=${s.isViewMode} mobile=${s.isMobileMode} jwt=${s.has_jwt} valid=${s.jwt_signature_valid} kind=${s.token_kind ?? "-"} lifetime=${s.lifetime_s ?? "-"}s key==docId=${s.documentId_equals_token_key} ocsKey==docId=${s.ocs_key_matches_documentId} user∈info.users=${s.info_users_contains_token_user}`);
  log(`claims: ${(s.claim_names || []).join(", ")}`);
}

function apiPresent() {
  const present = new Set(), missing = new Set();
  for (const s of Object.values(facts.sessions)) {
    for (const [q, ok] of Object.entries(s.presence?.result?.present || {})) {
      const m = q.split(".").pop();
      (ok ? present : missing).add(m);
    }
  }
  for (const m of present) missing.delete(m);
  return { present: [...present].sort(), missing: [...missing].sort() };
}

function summarise() {
  const S = Object.values(facts.sessions);
  const edits = S.filter((s) => s.isViewMode === false), views = S.filter((s) => s.isViewMode === true);
  const sum = facts.summary;
  sum.S9_has_jwt = S.length ? S.every((s) => s.has_jwt) : null;
  sum.S9_jwt_signature_valid = S.length ? S.every((s) => s.jwt_signature_valid) : null;
  sum.S9_documentId_equals_key = S.length ? S.every((s) => s.documentId_equals_token_key === true && s.ocs_key_matches_documentId === true) : null;
  sum.S9_token_user_in_info_users = S.length ? S.every((s) => s.info_users_contains_token_user === true) : null;
  sum.S9_token_kinds = [...new Set(S.map((s) => `${s.editorType}/${s.isViewMode ? "view" : "edit"}: ${s.token_kind} (${s.lifetime_s}s)`))];
  sum.S9_view_mode_on_phone = views.length ? views.some((s) => s.isMobileMode === true) ? true : "view session seen, but isMobileMode was not true" : null;
  // View-mode claim: compare an edit and a view token for the same editor type
  const ew = edits.find((s) => s.editorType === "word"), vw = views.find((s) => s.editorType === "word");
  if (ew && vw) {
    const a = new Set(ew.claim_names || []), b = new Set(vw.claim_names || []);
    const diff = {};
    for (const k of new Set([...Object.keys(ew.view_markers || {}), ...Object.keys(vw.view_markers || {})])) if (ew.view_markers?.[k] !== vw.view_markers?.[k]) diff[k] = { edit: ew.view_markers?.[k] ?? null, view: vw.view_markers?.[k] ?? null };
    sum.S9_view_mode_claim = { marker_values_that_differ: diff, claims_only_in_edit: [...a].filter((x) => !b.has(x)), claims_only_in_view: [...b].filter((x) => !a.has(x)) };
  }
  const st = S.map((s) => s.structured).filter(Boolean);
  sum.S9_callcommand_structured_result = st.length ? st.every((o) => o.callback && o.result && o.result.ok === true) : null;
  const ind = S.map((s) => s.indicator).filter(Boolean);
  sum.S9_indicator_method = ind.length ? ind.map((o) => `start ${o.start}, end ${o.end}`).join("; ") + " (Kevin confirms whether 'Crow probe…' was visible)" : null;
  const ed = S.map((s) => s.edit).filter(Boolean);
  sum.S9_edit_command = ed.length ? ed.map((o) => (o.callback ? JSON.stringify(o.result) : `no callback (${o.threw || "timeout"})`)).join("; ") + " (Kevin confirms CROW-PROBE survived close/save)" : null;
  // Cell edit-mode no-op: ticks inside the marked window
  const start = facts.marks.find((m) => m.label === "cell_edit_start"), end = facts.marks.find((m) => m.label === "cell_edit_end");
  const ticks = S.flatMap((s) => s.ticks || []);
  if (start && end) {
    const inWin = ticks.filter((t) => t.at >= start.at && t.at <= end.at);
    sum.S9_command_noop_while_user_edits_cell = inWin.length
      ? { ticks_in_window: inWin.length, ran: inWin.filter((t) => t.outcome?.callback && t.outcome.result?.ok === true).length, no_callback: inWin.filter((t) => !t.outcome?.callback).length, callback_not_ok: inWin.filter((t) => t.outcome?.callback && t.outcome.result?.ok !== true).length }
      : "no ticks landed inside the marked cell-edit window";
  }
  const ap = apiPresent();
  sum.api_present = ap.present; sum.api_missing = ap.missing;
  sum.api_present_line = `API present: ${ap.present.join(", ")}`;
}

async function onMark(b) {
  const m = { label: String(b.label || ""), at: Date.now() };
  if (m.label === "phone_viewing" || m.label === "baseline_no_editor_open") {
    try { const st = await stat(`${DIR}/probe.docx`); m.lock = { lock: st.lock, type: st.lockType, owner: st.lockOwner }; } catch (e) { m.lock = `error: ${e.message}`; }
    if (m.label === "phone_viewing") facts.summary.S9_phone_locks_file = m.lock;
    if (m.label === "baseline_no_editor_open") facts.summary.S9_lock_baseline_before_phone = m.lock;
  }
  facts.marks.push(m);
  log(`mark ${m.label}${m.lock ? ` lock=${JSON.stringify(m.lock)}` : ""}`);
}

const server = createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(404).end(); return; }
  let size = 0; const chunks = [];
  req.on("data", (c) => { size += c.length; if (size > 1 << 20) { res.writeHead(413).end(); req.destroy(); } else chunks.push(c); });
  req.on("end", async () => {
    let b;
    try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { res.writeHead(400).end(); return; }
    res.writeHead(204).end();
    const viaServe = !!req.headers["x-forwarded-for"] || !!req.headers["tailscale-user-login"];
    try {
      if (b.kind === "mark") { if (viaServe) return; await onMark(b); }
      else if (b.kind === "init") await onInit(b);
      else if (b.kind === "structured") { session(b.session).structured = b.outcome; log(`structured ${b.editorType}: ${JSON.stringify(b.outcome)}`); }
      else if (b.kind === "presence") {
        session(b.session).presence = b.outcome; summarise();
        const miss = Object.entries(b.outcome?.result?.present || {}).filter(([, ok]) => !ok).map(([q]) => q);
        log(`presence ${b.editorType}: callback=${b.outcome?.callback} missing=[${miss.join(", ")}]`);
        console.log(facts.summary.api_present_line);
      }
      else if (b.kind === "indicator") { session(b.session).indicator = b.outcome; log(`indicator ${b.editorType}: ${JSON.stringify(b.outcome)}`); }
      else if (b.kind === "edit") { session(b.session).edit = b.outcome; log(`edit ${b.editorType}: ${JSON.stringify(b.outcome)}`); }
      else if (b.kind === "tick") { session(b.session).ticks.push({ n: b.n, at: Date.now(), outcome: b.outcome }); log(`tick ${b.n}: ${b.outcome?.callback ? JSON.stringify(b.outcome.result) : "no callback"}`); }
      summarise(); persist();
    } catch (e) { log(`handler error (${b.kind}): ${e.message}`); }
  });
});

const shutdown = () => {
  summarise(); facts.stopped_at = new Date().toISOString(); persist();
  console.log("\nS9 SUMMARY\n" + JSON.stringify(facts.summary, null, 2));
  console.log(facts.summary.api_present_line);
  server.close(); process.exit(0);
};
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
server.listen(PORT, HOST, () => { log(`listening on http://${HOST}:${PORT} for ${DIR}${OUT ? `; facts -> ${OUT}` : ""}`); persist(); });
