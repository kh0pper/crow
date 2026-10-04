import { z } from "zod";
import { WsError } from "../result.js";
import { fileRef, refOf, toPublic, writeOpts, writeOptsOf } from "./common.js";
import { defineTools } from "./define.js";
import { stat, list, resolveRef, searchNames, mkcol, move, copy, remove, getFile } from "../nc/dav.js";
import { splitPath, splitFolder, joinPath } from "../nc/paths.js";
import { myShares, createUserShare } from "../nc/ocs.js";
import { lockInfo, classifyLock } from "../nc/locks.js";
import { exportAs } from "../nc/onlyoffice.js";
import { listVersions } from "../nc/versions.js";
import { withFileWrite, withFileRestore, createFile, refuseShareRoot, MAX_EDIT_BYTES } from "../write-protocol.js";
import { extractText } from "../ooxml/text-extract.js";

const PERMS = { R: "can_share", W: "can_write", D: "can_delete", C: "can_create", K: "can_create", N: "can_rename", V: "can_move" };

export const driveReadDefs = [
  { name: "ws_drive_list_folder", description: "List a folder in Crow's Workspace drive (\"\" = top level). Returns name, path, file_id, type, size, modified, locked.",
    schema: { path: z.string().max(4096).optional().default("") },
    run: async ({ path }, { getConfig }) => { const cfg = getConfig(); const items = await list(cfg, splitFolder(path)); return { path, items: items.map((e) => toPublic(e, cfg)) }; } },
  { name: "ws_drive_find_folder", description: "Find a folder by exact name (optionally under parent). Returns found, path, file_id.",
    schema: { name: z.string().min(1).max(255), parent: z.string().max(4096).optional().default("") },
    run: async ({ name, parent }, { getConfig }) => { const cfg = getConfig(); const hits = await searchNames(cfg, { scopeSegs: splitFolder(parent), eq: name, foldersOnly: true, limit: 5 }); return hits.length ? { found: true, path: hits[0].path, file_id: hits[0].fileId } : { found: false }; } },
  { name: "ws_drive_get_metadata", description: "Size, type, modified time, owner, Crow bot's permissions, lock state and web link of a file or folder.",
    schema: { ...fileRef },
    run: async (args, { getConfig }) => { const cfg = getConfig(); const e = await stat(cfg, refOf(args)); const l = lockInfo(e); return { ...toPublic(e, cfg), etag: e.etag, owner: { id: e.ownerId, name: e.ownerName }, permissions: e.permissions, lock: l ? { type: l.type, by: l.ownerName, since: l.since } : null }; } },
  { name: "ws_drive_get_permissions", description: "Read-only: who owns this, what Crow bot may do with it, and shares Crow bot made.",
    schema: { ...fileRef },
    run: async (args, { getConfig }) => {
      const cfg = getConfig(); const e = await stat(cfg, refOf(args));
      const crow_bot = Object.fromEntries(Object.values(PERMS).map((k) => [k, false]));
      for (const ch of e.permissions) if (PERMS[ch]) crow_bot[PERMS[ch]] = true;
      let shares = null, note = "Crow bot cannot see other people's shares of this item.";
      try { shares = (await myShares(cfg, splitPath(e.path))).map((s) => ({ with: s.share_with, permissions: s.permissions })); }
      catch { note += " Crow bot's own shares could not be read right now."; }
      return { path: e.path, owner: { id: e.ownerId, name: e.ownerName }, crow_bot, shares_by_crow_bot: shares, note };
    } },
  { name: "ws_drive_read_file", description: "Read a file as text: .docx → markdown, .xlsx → each tab as CSV-like text, .pptx → slide text + notes; text files (text/*, .md, .csv, .json, .ics, .vcf…) as UTF-8. Other files are refused (not_text) with their metadata. truncated:true when cut at max_chars.",
    schema: { ...fileRef, max_chars: z.number().int().min(1).max(1000000).optional().default(200000) },
    run: async (args, { getConfig }) => {
      const cfg = getConfig(); const segs = await resolveRef(cfg, refOf(args)); const e = await stat(cfg, segs);
      if (e.isFolder) throw new WsError("not_a_file", `"${e.path}" is a folder; list it with ws_drive_list_folder`);
      const { bytes } = await getFile(cfg, segs, { maxBytes: MAX_EDIT_BYTES });
      const text = extractText(e.name, bytes, e.mime);
      if (text === null) throw new WsError("not_text", `"${e.name}" is not a document or text file Crow can read`, { path: e.path, file_id: e.fileId, size: e.size, mime: e.mime });
      return { path: e.path, file_id: e.fileId, text: text.slice(0, args.max_chars), truncated: text.length > args.max_chars };
    } },
  { name: "ws_drive_search", description: "Search file and folder names in Crow's Workspace drive (newest first).",
    schema: { query: z.string().min(1).max(200), max_results: z.number().int().min(1).max(100).optional().default(20) },
    run: async ({ query, max_results }, { getConfig }) => { const cfg = getConfig(); return { results: (await searchNames(cfg, { like: query, limit: max_results })).map((e) => toPublic(e, cfg)) }; } },
];


const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const OFFICE = /\.(docx|xlsx|pptx)$/i;
const NAME_RE = /^[^/\\\u0000-\u001f\u007f]{1,255}$/;
const EXPORTS = { doc: ["pdf", "docx", "odt"], sheet: ["pdf", "xlsx", "ods", "csv"], slide: ["pdf", "pptx", "odp"] };
const familyOf = (name) => (/\.(docx|odt|doc|rtf|txt|md)$/i.test(name) ? "doc" : /\.(xlsx|ods|xls|csv)$/i.test(name) ? "sheet" : /\.(pptx|odp|ppt)$/i.test(name) ? "slide" : null);
const checkName = (n) => { const s = String(n).normalize("NFC"); if (!NAME_RE.test(s) || s === "." || s === ".." || Buffer.byteLength(s) > 255) throw new WsError("bad_path", "names cannot contain '/', '\\' or control characters"); return s; };

function decodeContent({ text, base64 }) {
  if ((text === undefined) === (base64 === undefined)) throw new WsError("bad_content", "give exactly one of text or base64");
  let bytes;
  if (text !== undefined) bytes = Buffer.from(text, "utf8");
  else if (/^[A-Za-z0-9+/]*={0,2}$/.test(base64) && base64.length % 4 === 0) bytes = Buffer.from(base64, "base64");
  else throw new WsError("bad_content", "base64 is not valid");
  if (bytes.length > 10 * 1024 * 1024) throw new WsError("too_large", "uploads are limited to 10 MB");
  return bytes;
}

export async function uniqueName(cfg, folderSegs, name) {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 1; i <= 50; i++) {
    const cand = i === 1 ? name : `${stem} (${i})${ext}`;
    try { await stat(cfg, [...folderSegs, cand]); } catch (e) { if (e.code === "not_found") return cand; throw e; }
  }
  throw new WsError("exists", "too many files with that name");
}

/** re-review minor: a 423 from MOVE/DELETE means the item (or something inside a folder) is open/locked. */
async function explain423(cfg, segs, err) {
  if (err?.code !== "locked") throw err;
  const e = await stat(cfg, segs).catch(() => null);
  if (e?.lock) { const c = await classifyLock(cfg, e); throw new WsError(c.code, c.message, { ...c.data, can_proceed: false }); }
  throw new WsError("locked_inside", `Something inside "${segs.at(-1)}" is open in the editor or locked; try again after it is closed.`);
}

/** move/rename/trash/share are not queueable (spec §5.6): an open file is refused, never closed. */
async function refuseIfOpen(cfg, e, waitS, clock) {
  const deadline = clock.now() + waitS * 1000;
  let cur = e;
  while (cur.lock && clock.now() < deadline) { await clock.sleep(2000); cur = await stat(cfg, splitPath(e.path)); }
  if (cur.lock) { const c = await classifyLock(cfg, cur); throw new WsError(c.code, c.message, { ...c.data, can_proceed: false }); }
}

export const driveWriteDefs = [
  { name: "ws_drive_create_folder", description: "Create a folder (idempotent: created:false if it already exists).",
    schema: { name: z.string().min(1).max(255), parent: z.string().max(4096).optional().default("") },
    run: async ({ name, parent }, { getConfig }) => { const cfg = getConfig(); const segs = [...splitFolder(parent), checkName(name)]; const created = await mkcol(cfg, segs); const e = await stat(cfg, segs); return { created, path: e.path, file_id: e.fileId }; } },
  { name: "ws_drive_move_file", description: "Move a file or folder into another folder (never overwrites).",
    schema: { path: z.string().max(4096), new_parent: z.string().max(4096) },
    run: async ({ path, new_parent }, { getConfig }) => {
      const cfg = getConfig(); const from = splitPath(path); const to = [...splitFolder(new_parent), from.at(-1)];
      if (joinPath(from) === joinPath(to)) { const e = await stat(cfg, from); return { moved: false, path: e.path, file_id: e.fileId }; }
      await move(cfg, from, to).catch((err) => explain423(cfg, from, err));
      const e = await stat(cfg, to); return { moved: true, path: e.path, file_id: e.fileId };
    } },
  { name: "ws_drive_copy_file", description: "Copy a file (adds ' (2)' etc. on a name clash).",
    schema: { path: z.string().max(4096), new_name: z.string().max(255).optional(), parent: z.string().max(4096).optional() },
    run: async ({ path, new_name, parent }, { getConfig }) => { const cfg = getConfig(); const from = splitPath(path); const folder = parent === undefined ? from.slice(0, -1) : splitFolder(parent); const name = await uniqueName(cfg, folder, checkName(new_name || from.at(-1))); await copy(cfg, from, [...folder, name]); const e = await stat(cfg, [...folder, name]); return { path: e.path, file_id: e.fileId }; } },
  { name: "ws_drive_rename", description: "Rename a file or folder in place (id unchanged).",
    schema: { path: z.string().max(4096), new_name: z.string().min(1).max(255) },
    run: async ({ path, new_name }, { getConfig }) => {
      const cfg = getConfig(); const from = splitPath(path); const name = checkName(new_name); const to = [...from.slice(0, -1), name];
      await move(cfg, from, to).catch((err) => explain423(cfg, from, err));
      const e = await stat(cfg, to); return { old_name: from.at(-1), name, path: e.path, file_id: e.fileId };
    } },
  { name: "ws_drive_trash_file", description: "Move a file or folder to the Workspace trash (recoverable). Destructive: confirm intent with the user first.",
    schema: { ...fileRef, wait_s: writeOpts.wait_s },
    run: async (args, { getConfig, clock }) => {
      const cfg = getConfig(); const segs = await resolveRef(cfg, refOf(args)); const e = await stat(cfg, segs);
      await refuseShareRoot(cfg, segs, e);
      await refuseIfOpen(cfg, e, args.wait_s ?? 0, clock);
      await remove(cfg, segs).catch((err) => explain423(cfg, segs, err));
      return { trashed: true, path: e.path, file_id: e.fileId };
    } },
  { name: "ws_drive_upload_file", description: "Create a NEW file from text or base64 (max 10 MB). Never overwrites. mime (optional) sets the content type, e.g. text/csv.",
    schema: { folder: z.string().max(4096), name: z.string().min(1).max(255), text: z.string().optional(), base64: z.string().optional(), mime: z.string().max(255).optional() },
    run: async (args, { getConfig, clock }) => {
      const cfg = getConfig(); const name = checkName(args.name);
      if (args.mime !== undefined && !MIME_RE.test(args.mime)) throw new WsError("bad_mime", "mime must look like type/subtype, e.g. text/csv");
      return createFile(cfg, splitFolder(args.folder), name, decodeContent(args), { summary: `upload ${name}`, clock, contentType: args.mime });
    } },
  { name: "ws_drive_upload_new_version", description: "Replace the content of a NON-office file (text, csv, images…). Refused for .docx/.xlsx/.pptx — use ws_docs_find_replace / ws_docs_replace_section / ws_sheets_write instead.",
    schema: { ...fileRef, text: z.string().optional(), base64: z.string().optional(), ...writeOpts },
    run: async (args, { getConfig, clock }) => {
      const cfg = getConfig(); const e = await stat(cfg, refOf(args));
      if (OFFICE.test(e.name)) throw new WsError("full_replace_refused", "Replacing a whole office document destroys its formatting. Use ws_docs_find_replace, ws_docs_replace_section or ws_sheets_write.");
      const bytes = decodeContent(args);
      return withFileWrite(cfg, refOf(args), async () => ({ bytes, changed: 1, summary: "new content" }), { ...writeOptsOf(args), clock });
    } },
  { name: "ws_drive_export", description: "Convert a document (pdf, docx, odt, xlsx, ods, csv, pptx, odp) with the document editor and save the result in the drive next to it (or in folder). Never overwrites.",
    schema: { ...fileRef, format: z.enum(["pdf", "docx", "odt", "xlsx", "ods", "csv", "pptx", "odp"]), folder: z.string().max(4096).optional() },
    run: async (args, { getConfig, clock }) => {
      const cfg = getConfig(); const segs = await resolveRef(cfg, refOf(args)); const e = await stat(cfg, segs);
      const fam = familyOf(e.name);
      if (!fam || !EXPORTS[fam].includes(args.format)) throw new WsError("bad_format", `"${e.name}" can be exported as: ${(EXPORTS[fam] || []).join(", ") || "nothing"}`);
      const bytes = await exportAs(cfg, e.fileId, args.format, MAX_EDIT_BYTES);
      const folder = args.folder === undefined ? segs.slice(0, -1) : splitFolder(args.folder);
      const name = await uniqueName(cfg, folder, `${e.name.replace(/\.[^.]+$/, "")}.${args.format}`);
      return createFile(cfg, folder, name, bytes, { summary: `export of ${e.name}`, clock });
    } },
  { name: "ws_drive_share", description: "Share a file or folder with one Workspace user (never a public link). role: reader or writer.",
    schema: { ...fileRef, user: z.string().min(1).max(64), role: z.enum(["reader", "writer"]) },
    run: async (args, { getConfig }) => {
      const cfg = getConfig();
      if (!/^[A-Za-z0-9_.@'-]{1,64}$/.test(args.user)) throw new WsError("bad_user", "user must be an exact Workspace login name");
      const segs = await resolveRef(cfg, refOf(args)); const e = await stat(cfg, segs);
      const permissions = args.role === "reader" ? 1 : e.isFolder ? 15 : 3;
      const s = await createUserShare(cfg, segs, args.user, permissions);
      return { shared: true, path: e.path, file_id: e.fileId, with: args.user, role: args.role, share_id: String(s.id) };
    } },
  { name: "ws_drive_list_versions", description: "List a file's saved versions (newest first): version_id, current (the one in use now; after an undo it is not the newest), time, author, label.",
    schema: { ...fileRef, limit: z.number().int().min(1).max(100).optional().default(20) },
    // re-review B1: after undo/restore the current row is NOT the newest id; mark it from the file's mtime.
    run: async (args, { getConfig }) => { const cfg = getConfig(); const e = await stat(cfg, refOf(args)); const v = await listVersions(cfg, e.fileId); return { path: e.path, file_id: e.fileId, versions: v.slice(0, args.limit).map((x) => ({ version_id: x.versionId, current: x.versionId === String(e.mtime), modified: x.modified, author: x.author, label: x.label, size: x.size })) }; } },
  { name: "ws_drive_restore_version", description: "Restore a listed version. The current content is kept as a version first, so this can be undone too.",
    schema: { ...fileRef, version_id: z.string().regex(/^\d{1,12}$/), ...writeOpts },
    run: async (args, { getConfig, clock }) => withFileRestore(getConfig(), refOf(args), args.version_id, { ...writeOptsOf(args), clock, summary: `restore version ${args.version_id}` }) },
];

export function registerDrive(server, ctx, extraDefs = []) { return defineTools(server, ctx, [...driveReadDefs, ...driveWriteDefs, ...extraDefs]); }
