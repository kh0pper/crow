import { z } from "zod";
import { fileRef, refOf, toPublic } from "./common.js";
import { defineTools } from "./define.js";
import { stat, list, resolveRef, searchNames } from "../nc/dav.js";
import { splitFolder } from "../nc/paths.js";
import { myShares } from "../nc/ocs.js";
import { lockInfo } from "../nc/locks.js";

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
      const shares = (await myShares(cfg, await resolveRef(cfg, refOf(args))).catch(() => [])).map((s) => ({ with: s.share_with, permissions: s.permissions }));
      return { path: e.path, owner: { id: e.ownerId, name: e.ownerName }, crow_bot, shares_by_crow_bot: shares, note: "Crow bot cannot see other people's shares of this item." };
    } },
  { name: "ws_drive_search", description: "Search file and folder names in Crow's Workspace drive (newest first).",
    schema: { query: z.string().min(1).max(200), max_results: z.number().int().min(1).max(100).optional().default(20) },
    run: async ({ query, max_results }, { getConfig }) => { const cfg = getConfig(); return { results: (await searchNames(cfg, { like: query, limit: max_results })).map((e) => toPublic(e, cfg)) }; } },
];

export function registerDrive(server, ctx, extraDefs = []) { return defineTools(server, ctx, [...driveReadDefs, ...extraDefs]); }
