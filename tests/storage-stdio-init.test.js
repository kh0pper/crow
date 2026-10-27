/**
 * The stdio storage server (servers/storage/index.js) follows the instance's Shared
 * Storage settings in the DB, like the gateway does (boot/admin-api.js initStorage), and
 * no longer depends on MINIO_* in the checkout .env (Garage migration PR 1).
 *
 * Before: it never called initStorage, so it used the env fallback — `localhost:9000`
 * on a host whose storage listens elsewhere, i.e. nothing. Here a scratch instance holds
 * sealed storage.shared.* rows pointing at a fake S3 endpoint; the server is spawned over
 * stdio and asked for a presigned URL. Both with MINIO_ENDPOINT unset and with the stale
 * `localhost` + MINIO_PORT=9000 a checkout .env carries, the URL and the request go to
 * the DB's endpoint, signed with the DB's key.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmScratch } from "./helpers/safe-rm.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), "crow-stdio-storage-home-"));
const DATA = join(HOME, "data");
const ACCESS = "GKstdioinit0123456789abcd";

let fake, port;
const seen = [];

before(async () => {
  fake = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: String(req.headers.authorization || "") });
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end('<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult><Owner><ID>x</ID></Owner><Buckets></Buckets></ListAllMyBucketsResult>');
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  port = fake.address().port;
  const env = { ...process.env, CROW_HOME: HOME, CROW_DATA_DIR: DATA };
  execFileSync(process.execPath, ["scripts/init-db.js"], { cwd: REPO, env, stdio: "pipe" });
  // Seal the rows exactly as the Shared Storage settings save does, with this instance's identity.
  const seed = `
    import { loadOrCreateIdentity } from "./servers/sharing/identity.js";
    import { sealSecret } from "./servers/sharing/secret-box.js";
    import { createDbClient } from "./servers/db.js";
    const id = loadOrCreateIdentity();
    const db = createDbClient();
    const rows = {
      "storage.shared.endpoint": "127.0.0.1:${port}",
      "storage.shared.use_ssl": "false",
      "storage.shared.region": "us-east-1",
      "storage.shared.bucket_prefix": "inst",
      "storage.shared.access_key": sealSecret("${ACCESS}", id),
      "storage.shared.secret_key": sealSecret("0123456789abcdef0123456789abcdef", id),
    };
    for (const [k, v] of Object.entries(rows)) {
      await db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES (?, ?)", args: [k, v] });
    }
    db.close();
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", seed], { cwd: REPO, env, stdio: "pipe" });
});

after(() => {
  fake?.close();
  rmScratch(HOME);
});

/** Spawn the stdio server, initialize, call one tool, return its text. */
async function callTool(extraEnv, name, args) {
  const env = { ...process.env, CROW_HOME: HOME, CROW_DATA_DIR: DATA, ...extraEnv };
  for (const k of ["MINIO_ENDPOINT", "MINIO_PORT", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "MINIO_USE_SSL", "S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY"]) {
    if (!(k in extraEnv)) delete env[k];
  }
  const child = spawn(process.execPath, ["servers/storage/index.js"], { cwd: REPO, env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let stderr = "";
  const waiters = new Map();
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { throw new Error(`non-JSON on stdout (breaks the MCP stream): ${line}`); }
      waiters.get(msg.id)?.(msg);
    }
  });
  const rpc = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on ${method}; stderr: ${stderr}`)), 15000);
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    await rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const r = await rpc(2, "tools/call", { name, arguments: args });
    return { text: r.result?.content?.[0]?.text || "", isError: !!r.result?.isError, stderr };
  } finally {
    child.kill();
  }
}

for (const [label, extraEnv] of [
  ["MINIO_ENDPOINT unset", {}],
  ["a stale checkout .env (localhost, MINIO_PORT=9000)", { MINIO_ENDPOINT: "localhost", MINIO_PORT: "9000", MINIO_ROOT_PASSWORD: "stale-root-password" }],
]) {
  test(`stdio storage server follows the DB's Shared Storage config (${label})`, async () => {
    seen.length = 0;
    const r = await callTool(extraEnv, "crow_get_file_url", { s3_key: "notes/a.txt" });
    assert.equal(r.isError, false, `${r.text}\n${r.stderr}`);
    assert.ok(r.text.includes(`http://127.0.0.1:${port}/inst-files/notes/a.txt?`), r.text);
    assert.ok(r.text.includes(`X-Amz-Credential=${ACCESS}`), "signed with the DB's key");
    assert.ok(seen.length > 0, "the availability probe reached the DB endpoint");
    assert.ok(seen.every((s) => s.auth.includes(`Credential=${ACCESS}/`)), "every request carries the DB's key");
  });
}
