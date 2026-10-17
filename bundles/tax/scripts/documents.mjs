#!/usr/bin/env node
/**
 * Crow Tax — stored documents, by hand.
 *
 *   node scripts/documents.mjs encrypt                 encrypt every plain stored document
 *                                                      (what the dashboard does at start-up)
 *   node scripts/documents.mjs decrypt --out <folder>  write plain copies there (0600);
 *                                                      the database is not changed
 *   node scripts/documents.mjs decrypt --in-place      undo the encryption (a downgrade):
 *                                                      set CROW_TAX_KEEP_PLAIN_DOCUMENTS=1
 *                                                      first, or the next start encrypts again
 *
 * The key comes from this instance's tax entry in mcp-addons.json, else
 * CROW_TAX_ENCRYPTION_KEY (and _PREVIOUS) — the MCP server's order. It is never printed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createDbClient } from "../server/db.js";
import { encryptStoredDocuments, decryptStoredDocuments } from "../server/documents-crypto.js";

function keys() {
  let entry = {};
  try { entry = JSON.parse(readFileSync(join(process.env.CROW_HOME || join(homedir(), ".crow"), "mcp-addons.json"), "utf8"))?.tax?.env || {}; } catch { /* none */ }
  return {
    key: entry.CROW_TAX_ENCRYPTION_KEY || process.env.CROW_TAX_ENCRYPTION_KEY || "",
    previous: entry.CROW_TAX_ENCRYPTION_KEY_PREVIOUS || process.env.CROW_TAX_ENCRYPTION_KEY_PREVIOUS || "",
  };
}

const [cmd, ...rest] = process.argv.slice(2);
const { key, previous } = keys();
if (!key) { console.error("No tax key: install the tax extension, or set CROW_TAX_ENCRYPTION_KEY."); process.exit(2); }
// The database of the SAME instance as the key and the folders (CROW_HOME), never another one's.
if (process.env.CROW_HOME && !process.env.CROW_DB_PATH && !process.env.CROW_DATA_DIR && !process.env.CROW_TAX_DB_PATH) {
  process.env.CROW_DB_PATH = join(process.env.CROW_HOME, "data", "crow.db");
}
const db = createDbClient();
let out;
if (cmd === "encrypt") {
  out = await encryptStoredDocuments(db, { key, previous });
} else if (cmd === "decrypt" && rest[0] === "--in-place") {
  out = await decryptStoredDocuments(db, { keys: [key, previous], inPlace: true });
} else if (cmd === "decrypt" && rest[0] === "--out" && rest[1]) {
  out = await decryptStoredDocuments(db, { keys: [key, previous], outDir: rest[1] });
} else {
  console.error("usage: documents.mjs encrypt | decrypt --out <folder> | decrypt --in-place");
  process.exit(2);
}
console.log(JSON.stringify(out, null, 2));
process.exit(out.errors?.length || out.locked ? 1 : 0);
