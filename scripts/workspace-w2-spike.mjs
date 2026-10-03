#!/usr/bin/env node
// W2 spike: verifies the live Nextcloud/ONLYOFFICE behaviour the write protocol relies on.
// Usage: node scripts/workspace-w2-spike.mjs [--editor-test] [--capture-fixtures]
// Reads ~/.crow/bundles/workspace/.env via the bundle codec. Prints facts, never secrets.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHmac } from "node:crypto";
import { parseEnvText } from "../servers/gateway/bundle-env-codec.js";

const env = parseEnvText(readFileSync(join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "workspace", ".env"), "utf8"));
const NC = "http://127.0.0.1:3070", OO = "http://127.0.0.1:3071", U = "crow-bot";
const AUTH = "Basic " + Buffer.from(`${U}:${env.WORKSPACE_BOT_APP_PASSWORD}`).toString("base64");
const args = new Set(process.argv.slice(2));
const ask = () => new Promise((r) => process.stdin.once("data", (d) => { process.stdin.pause(); r(d); })); // [deviation]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const facts = [];
const fact = (k, v) => { facts.push([k, v]); console.log(`FACT ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`); };
const dav = (method, path, { headers = {}, body } = {}) => fetch(`${NC}/remote.php/dav/${path}`, { method, headers: { Authorization: AUTH, ...headers }, body });
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const xmlUnescape = (v) => v == null ? v : v.replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"); // [deviation] NC escapes the etag quotes as &quot;
const prop = (xml, name) => xmlUnescape((xml.match(new RegExp(`<${name}>([^<]*)<`)) || [])[1] ?? null); // spike-only; product code uses xmldom
const jwt = (payload) => { const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const h = `${b({ alg: "HS256", typ: "JWT" })}.${b(payload)}`; return `${h}.${createHmac("sha256", env.WORKSPACE_ONLYOFFICE_JWT_SECRET).update(h).digest("base64url")}`; };
const cmd = async (payload) => { const t = jwt(payload); return (await fetch(`${OO}/coauthoring/CommandService.ashx`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: JSON.stringify({ ...payload, token: t }) })).json(); };
const PF = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:prop><d:getetag/><d:getlastmodified/><oc:fileid/><nc:lock/><nc:lock-owner-type/><nc:lock-owner/></d:prop></d:propfind>`;
const stat = async (p) => { const x = await (await dav("PROPFIND", `files/${U}/${enc(p)}`, { headers: { Depth: "0" }, body: PF })).text(); return { etag: prop(x, "d:getetag"), mtime: Date.parse(prop(x, "d:getlastmodified")) / 1000, fileid: Number(prop(x, "oc:fileid")), lock: prop(x, "nc:lock"), lockType: prop(x, "nc:lock-owner-type"), lockOwner: prop(x, "nc:lock-owner") }; };
const versions = async (fid) => { const x = await (await dav("PROPFIND", `versions/${U}/versions/${fid}`, { headers: { Depth: "1" } })).text(); return [...x.matchAll(/versions\/\d+\/(\d+)</g)].map((m) => m[1]); };

const list = await (await dav("PROPFIND", `files/${U}/Shared%20with%20Crow/`, { headers: { Depth: "1" } })).text();
const parent = decodeURIComponent((list.match(/<d:href>\/remote\.php\/dav\/files\/crow-bot\/(Shared%20with%20Crow\/[^<]+\/)<\/d:href>/) || [])[1] || "Shared%20with%20Crow/");
const DIR = `${parent}W2 spike ${Date.now()}`; // visible in the Files UI (dot-folders are hidden)
fact("scratch_dir", DIR);
fact("mkcol", (await dav("MKCOL", `files/${U}/${enc(DIR)}`)).status);
// [deviation] try/finally: a mid-run failure must still trash the scratch folder
try {

// S1 versions per PUT; ids = mtimes
const f = `${DIR}/v.txt`;
await dav("PUT", `files/${U}/${enc(f)}`, { body: "one" }); await sleep(1500);
const s1 = await stat(f);
const put2 = await dav("PUT", `files/${U}/${enc(f)}`, { headers: { "If-Match": s1.etag }, body: "two" });
const s2 = await stat(f);
const v2 = await versions(s2.fileid);
fact("S1_put_if_match_status", put2.status);
fact("S1_versions_after_two_puts", v2);
fact("S1_current_listed_as_version", v2.includes(String(s2.mtime)));
fact("S1_previous_version_id_equals_old_mtime", v2.includes(String(s1.mtime)));

// S2 label a version; etag unchanged?
const pp = await dav("PROPPATCH", `versions/${U}/versions/${s2.fileid}/${s1.mtime}`, { headers: { "Content-Type": "application/xml" }, body: `<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:set><d:prop><nc:version-label>Before Crow: spike</nc:version-label></d:prop></d:set></d:propertyupdate>` });
fact("S2_label_status", pp.status);
fact("S2_etag_unchanged_by_label", (await stat(f)).etag === s2.etag);
const pp2 = await dav("PROPPATCH", `versions/${U}/versions/${s2.fileid}/${s2.mtime}`, { headers: { "Content-Type": "application/xml" }, body: `<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:set><d:prop><nc:version-label>Crow: spike</nc:version-label></d:prop></d:set></d:propertyupdate>` });
fact("S2b_label_current_version_status", pp2.status);
fact("S2c_etag_unchanged_by_labeling_current", (await stat(f)).etag === s2.etag); // every undo token depends on this

// S3 restore via MOVE
const mv = await dav("MOVE", `versions/${U}/versions/${s2.fileid}/${s1.mtime}`, { headers: { Destination: `${NC}/remote.php/dav/versions/${U}/restore/target` } });
fact("S3_restore_status", mv.status);
fact("S3_content_after_restore", await (await dav("GET", `files/${U}/${enc(f)}`)).text());
fact("S3_versions_after_restore", await versions(s2.fileid));
const s3 = await stat(f);
fact("S3b_mtime_after_restore_equals_revision", s3.mtime === s1.mtime); // NC touches back to the revision

// S4 two PUTs 1.1 s apart → two versions?
const g = `${DIR}/fast.txt`;
await dav("PUT", `files/${U}/${enc(g)}`, { body: "a" }); await sleep(1100);
await dav("PUT", `files/${U}/${enc(g)}`, { body: "b" }); await sleep(1100);
await dav("PUT", `files/${U}/${enc(g)}`, { body: "c" });
fact("S4_versions_for_three_puts_1100ms", (await versions((await stat(g)).fileid)).length);

// S5 info on a never-opened key → error 1
const cfg = await (await fetch(`${NC}/ocs/v2.php/apps/onlyoffice/api/v1/config/${s2.fileid}?format=json`, { headers: { Authorization: AUTH, "OCS-APIRequest": "true" } })).json();
fact("S5_config_has_key", !!cfg?.document?.key);
fact("S5_info_no_session", await cmd({ c: "info", key: cfg.document.key }));

if (args.has("--editor-test")) {
  // S6 [KEVIN]: open <DIR>/editor.docx in Workspace, type a word, leave the tab open, press Enter here.
  const e = `${DIR}/editor.docx`;
  await dav("PUT", `files/${U}/${enc(e)}`, { body: readFileSync(join(import.meta.dirname, "..", "tests", "fixtures", "workspace", "rich.docx")) });
  console.log(`\n[KEVIN] Open "${e}" in Workspace (ONLYOFFICE), type the word SPIKE anywhere, keep the tab open, then press Enter here.`);
  await ask();
  const st = await stat(e);
  fact("S6_lock_while_open", { lock: st.lock, type: st.lockType, owner: st.lockOwner });
  const before = await (await dav("GET", `files/${U}/${enc(e)}`)).arrayBuffer();
  fact("S6_put_while_open_status", (await dav("PUT", `files/${U}/${enc(e)}`, { headers: { "If-Match": st.etag }, body: Buffer.from(before) })).status);
  const key = (await (await fetch(`${NC}/ocs/v2.php/apps/onlyoffice/api/v1/config/${st.fileid}?format=json`, { headers: { Authorization: AUTH, "OCS-APIRequest": "true" } })).json()).document.key;
  const info = await cmd({ c: "info", key });
  fact("S6_info", info);
  const t0 = Date.now();
  fact("S6_drop", await cmd({ c: "drop", key, users: info.users || [] }));
  let cleared = null;
  for (let i = 0; i < 30; i++) { await sleep(1000); if ((await stat(e)).lock !== "1") { cleared = (Date.now() - t0) / 1000; break; } }
  fact("S6_seconds_until_unlock", cleared);
  const after = Buffer.from(await (await dav("GET", `files/${U}/${enc(e)}`)).arrayBuffer());
  // fflate is only installed in Task 3: use the system unzip here (Info-ZIP is on crow)
  const { writeFileSync: wf } = await import("node:fs"); const { execFileSync } = await import("node:child_process");
  const tmp = `/tmp/w2-spike-${Date.now()}.docx`; wf(tmp, after);
  fact("S6_typing_saved_contains_SPIKE", execFileSync("unzip", ["-p", tmp, "word/document.xml"]).toString().includes("SPIKE"));
  (await import("node:fs")).unlinkSync(tmp); // [deviation] Step 7: the temp copy is deleted
  const vAfterDrop = await versions(st.fileid);
  fact("S6_versions", vAfterDrop);
  // S6b: the real proceed sequence: bot PUT right after the unlock, honouring the ≥1.1 s mtime gap
  const sNow = await stat(e);
  await sleep(Math.max(0, (sNow.mtime + 1.1) * 1000 - Date.now()));
  fact("S6b_bot_put_after_unlock_status", (await dav("PUT", `files/${U}/${enc(e)}`, { headers: { "If-Match": sNow.etag }, body: after })).status);
  const vFinal = await versions(st.fileid);
  fact("S6b_person_save_and_bot_write_are_distinct_versions", vFinal.length === vAfterDrop.length + 1);
  console.log("[KEVIN] What did the editor tab show after the drop? Type a short description and press Enter:");
  fact("S6_editor_ui", String(await ask()).trim());
}

// S8: calendar delete → re-create at the same href/UID (the undo path) while NC's calendar trash holds it.
// Needs a calendar crow-bot can write; skipped (fact = "skipped") until Kevin has shared Menu with crow-bot.
{
  const home = await (await dav("PROPFIND", `calendars/${U}/`, { headers: { Depth: "1" } })).text();
  const href = (home.match(/<d:href>(\/remote\.php\/dav\/calendars\/crow-bot\/[^<]*menu[^<]*\/)<\/d:href>/i) || [])[1];
  if (!href) fact("S8_cal_delete_then_recreate", "skipped (Menu not shared with crow-bot yet)");
  else {
    const uid = `w2-spike-${Date.now()}`; const obj = `${href}${uid}.ics`.replace("/remote.php/dav/", "");
    const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Crow//spike//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261003T000000Z\r\nDTSTART;VALUE=DATE:20300101\r\nDTEND;VALUE=DATE:20300102\r\nSUMMARY:W2 spike\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    await dav("PUT", obj, { headers: { "Content-Type": "text/calendar" }, body: ics });
    await dav("DELETE", obj);
    fact("S8_cal_recreate_same_href_after_delete_status", (await dav("PUT", obj, { headers: { "Content-Type": "text/calendar", "If-None-Match": "*" }, body: ics })).status);
    await dav("DELETE", obj);
  }
}

if (args.has("--capture-fixtures")) {
  // S7 [KEVIN]: open each rich.* in ONLYOFFICE, type one character and delete it, close the tab; press Enter here.
  for (const ext of ["docx", "xlsx", "pptx"]) await dav("PUT", `files/${U}/${enc(`${DIR}/rich.${ext}`)}`, { body: readFileSync(join(import.meta.dirname, "..", "tests", "fixtures", "workspace", `rich.${ext}`)) });
  console.log(`\n[KEVIN] In "${DIR}": open rich.docx, rich.xlsx, rich.pptx one at a time, make a tiny edit (type and delete a character), close each tab. Wait 20 s after the last close, then press Enter.`);
  await ask();
  const { writeFileSync } = await import("node:fs");
  for (const ext of ["docx", "xlsx", "pptx"]) {
    const b = Buffer.from(await (await dav("GET", `files/${U}/${enc(`${DIR}/rich.${ext}`)}`)).arrayBuffer());
    writeFileSync(join(import.meta.dirname, "..", "tests", "fixtures", "workspace", `oo-rich.${ext}`), b);
    fact(`S7_captured_oo-rich.${ext}_bytes`, b.length);
  }
}

} catch (err) {
  fact("error", String(err?.stack || err));
  process.exitCode = 1;
} finally {
  fact("cleanup_delete", (await dav("DELETE", `files/${U}/${enc(DIR)}`)).status);
  console.log("\nFACTS JSON\n" + JSON.stringify(Object.fromEntries(facts), null, 2));
  process.stdin.pause(); // [deviation] a stdin read leaves the stream flowing; pause so the process can exit
}
