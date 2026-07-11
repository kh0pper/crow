import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { appImport } from "./app-root.js";

const { createDbClient: createSharedDbClient } = await appImport("servers/db.js");

const __dirname = dirname(fileURLToPath(import.meta.url));

export function sanitizeFtsQuery(input) {
  if (!input || typeof input !== "string") return null;
  const cleaned = input
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, "")
    .replace(/[*"(){}[\]^~:]/g, "")
    .trim();
  if (!cleaned) return null;
  const terms = cleaned
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"`)
    .join(" ");
  return terms || null;
}

export function escapeLikePattern(input) {
  if (!input || typeof input !== "string") return input;
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function resolveDataDir() {
  if (process.env.CROW_DATA_DIR) return resolve(process.env.CROW_DATA_DIR);
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const crowHome = resolve(home, ".crow", "data");
  if (home && existsSync(crowHome)) return crowHome;
  const repoData = resolve(__dirname, "../../../data");
  if (existsSync(repoData)) return repoData;
  return resolve(home || ".", "data");
}

export function createDbClient(dbPath) {
  const filePath = dbPath || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db");
  // Delegate to the shared better-sqlite3 wrapper (same libsql-shaped surface:
  // execute/batch/executeMultiple/close). The raw @libsql/client this used to
  // construct does NOT share a transaction across separate execute() calls, so
  // the W2-5 B2 FK-rebuild's BEGIN IMMEDIATE … COMMIT bracketing silently ran
  // autocommit and the trailing COMMIT threw — crashing bundle boot and
  // voiding the rebuild's atomicity guarantee. The shared wrapper holds real
  // transactions across calls (and is what data-dashboard already uses).
  return createSharedDbClient(filePath);
}
