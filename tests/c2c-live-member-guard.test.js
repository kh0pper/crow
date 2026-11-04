/**
 * W4 of the Task 6 fix wave: the OLD member editors never touch a LIVE row.
 *
 * A Crow-to-Crow membership lives in `project_members` with `mode='live'` and is
 * owned by the sharing controls (invite / role / unshare), which also tell the
 * visitor's Crow. The three older writers — the Projects panel's add/remove forms,
 * the research MCP tools `crow_add_member`/`crow_remove_member`, and `crow_share`'s
 * clone path — must therefore refuse a live row and leave it exactly as it was,
 * while a non-live row (clone/plain) keeps behaving as before.
 *
 * Every case runs against a REAL scripts/init-db.js database (the real role CHECK,
 * the real partial unique indexes); nothing about the schema is faked here.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";

const REPO = join(import.meta.dirname, "..");
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A fresh init-db'd crow.db (never ~/.crow: CROW_DATA_DIR wins, CROW_DB_PATH blanked). */
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "c2c-live-guard-"));
  dirs.push(dir);
  const dbPath = join(dir, "crow.db");
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "", CROW_HOME: join(dir, ".crow") },
    stdio: "pipe",
    cwd: REPO,
  });
  const db = createDbClient(dbPath);
  return {
    dir, dbPath, db,
    close() { try { db.close(); } catch { /* already closed */ } },
  };
}

let seq = 0;

/**
 * A project with its local OWNER row (every writer is gated on manage_members) and
 * one contact whose membership has `mode` (null = the old plain member row).
 */
async function seed(s, { mode = "live", role = "viewer" } = {}) {
  const slug = `labs-${++seq}`;
  const project = await s.db.execute({
    sql: "INSERT INTO project_spaces (slug, name, type) VALUES (?, ?, 'general')",
    args: [slug, `Labs ${seq}`],
  });
  const projectId = Number(project.lastInsertRowid);
  await s.db.execute({
    sql: "INSERT INTO project_members (project_id, contact_id, role) VALUES (?, NULL, 'owner')",
    args: [projectId],
  });
  const contact = await s.db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey)
          VALUES (?, 'alex', ?, ?)`,
    args: [`crow:guard-${seq}`, "a".repeat(64), "b".repeat(64)],
  });
  const contactId = Number(contact.lastInsertRowid);
  const member = await s.db.execute({
    sql: `INSERT INTO project_members (project_id, contact_id, role, capabilities, mode, accepted_at, origin_instance_id)
          VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    args: [
      projectId, contactId, role, mode,
      mode === "live" ? "2026-11-01 00:00:00" : null,
      mode === "live" ? "inst-visitor" : null,
    ],
  });
  return {
    projectId,
    contactId,
    crowId: `crow:guard-${seq}`,
    memberId: Number(member.lastInsertRowid),
  };
}

async function memberRow(s, projectId, contactId) {
  const { rows } = await s.db.execute({
    sql: `SELECT id, role, capabilities, mode, accepted_at, revoked_at, origin_instance_id
            FROM project_members WHERE project_id = ? AND contact_id = ? ORDER BY id DESC LIMIT 1`,
    args: [projectId, contactId],
  });
  return rows[0] ?? null;
}

/* ------------------------------------------------------- the Projects panel */

const panel = (await import("../servers/gateway/dashboard/panels/projects.js")).default;

/** Drive the panel's POST branch exactly as the dashboard dispatcher does. */
async function postPanel(db, body) {
  const out = { redirect: null };
  const res = { redirectAfterPost(url) { out.redirect = url; } };
  await panel.handler({ method: "POST", body, query: {}, headers: {} }, res, {
    db, layout: ({ content }) => content, lang: "en",
  });
  return out;
}

/** Render the detail view (the page the redirect lands on). */
async function renderPanel(db, query, lang = "en") {
  const res = { redirectAfterPost(url) { throw new Error(`GET must not redirect (${url})`); } };
  return panel.handler({ method: "GET", body: {}, query, headers: {} }, res, {
    db, layout: ({ content }) => content, lang,
  });
}

test("panel add_member: a live row is refused and left exactly as it was", async () => {
  const s = fresh();
  try {
    const p = await seed(s, { mode: "live", role: "viewer" });
    const before = await memberRow(s, p.projectId, p.contactId);

    const out = await postPanel(s.db, {
      action: "add_member", id: String(p.projectId), contact_id: String(p.contactId),
      role: "owner", capabilities: '{"manage_members":true}',
    });

    assert.equal(out.redirect, `/dashboard/projects?view=${p.projectId}&error=live_member`);
    assert.deepEqual(await memberRow(s, p.projectId, p.contactId), before,
      "role, capabilities, mode, accepted_at and origin_instance_id are untouched");
    const audits = (await s.db.execute({
      sql: "SELECT action FROM project_audit_log WHERE project_id = ?", args: [p.projectId],
    })).rows;
    assert.equal(audits.length, 0, "a refused edit writes no audit row either");
  } finally { s.close(); }
});

test("panel add_member: a non-live row still updates as before", async () => {
  const s = fresh();
  try {
    const p = await seed(s, { mode: "clone", role: "viewer" });

    const out = await postPanel(s.db, {
      action: "add_member", id: String(p.projectId), contact_id: String(p.contactId),
      role: "editor", capabilities: "",
    });

    assert.equal(out.redirect, `/dashboard/projects?view=${p.projectId}&tab=members`);
    const row = await memberRow(s, p.projectId, p.contactId);
    assert.equal(row.role, "editor");
    assert.equal(row.mode, "clone", "the mode is not promoted by the old editor");
    const audits = (await s.db.execute({
      sql: "SELECT action FROM project_audit_log WHERE project_id = ?", args: [p.projectId],
    })).rows;
    assert.deepEqual(audits.map((a) => a.action), ["member.update"]);
  } finally { s.close(); }
});

test("panel remove_member: a live row is refused and not revoked", async () => {
  const s = fresh();
  try {
    const p = await seed(s, { mode: "live", role: "editor" });
    const before = await memberRow(s, p.projectId, p.contactId);

    const out = await postPanel(s.db, {
      action: "remove_member", id: String(p.projectId), contact_id: String(p.contactId),
    });

    assert.equal(out.redirect, `/dashboard/projects?view=${p.projectId}&error=live_member`);
    assert.deepEqual(await memberRow(s, p.projectId, p.contactId), before, "not revoked, nothing written");
  } finally { s.close(); }
});

test("panel remove_member: a non-live row is still revoked", async () => {
  const s = fresh();
  try {
    const p = await seed(s, { mode: "clone", role: "editor" });
    const out = await postPanel(s.db, {
      action: "remove_member", id: String(p.projectId), contact_id: String(p.contactId),
    });
    assert.equal(out.redirect, `/dashboard/projects?view=${p.projectId}&tab=members`);
    assert.notEqual((await memberRow(s, p.projectId, p.contactId)).revoked_at, null);
  } finally { s.close(); }
});

test("panel: the refusal reaches the page, in English and in Spanish", async () => {
  const s = fresh();
  try {
    const p = await seed(s, { mode: "live" });
    const en = await renderPanel(s.db, { view: String(p.projectId), error: "live_member" }, "en");
    assert.match(en, /This contact is a live member: change it in the Crow-to-Crow sharing controls\./);
    const es = await renderPanel(s.db, { view: String(p.projectId), error: "live_member" }, "es");
    assert.match(es, /Este contacto es un miembro en vivo: cámbialo en los controles de compartición de Crow a Crow\./);
    // Without the code the page says nothing about it.
    const clean = await renderPanel(s.db, { view: String(p.projectId) }, "en");
    assert.ok(!/live member/.test(clean));
  } finally { s.close(); }
});

/* --------------------------------------------------- the research MCP tools */

const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { createProjectServer } = await import("../servers/research/server.js");

async function researchClient(dbPath) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createProjectServer(dbPath);
  await server.connect(st);
  const client = new Client({ name: "live-guard", version: "0" });
  await client.connect(ct);
  return client;
}

const textOf = (r) => (r.content || []).map((c) => c.text).join("\n");
const REFUSAL = /This contact is a live member: change it in the Crow-to-Crow sharing controls\./;

test("crow_add_member: a live row is refused and left exactly as it was", async () => {
  const s = fresh();
  const client = await researchClient(s.dbPath);
  try {
    const p = await seed(s, { mode: "live", role: "viewer" });
    const before = await memberRow(s, p.projectId, p.contactId);

    const r = await client.callTool({
      name: "crow_add_member",
      arguments: { project_id: p.projectId, contact_id: p.contactId, role: "owner", mode: "clone" },
    });

    assert.equal(r.isError, true, "the tool refuses");
    assert.match(textOf(r), REFUSAL);
    assert.deepEqual(await memberRow(s, p.projectId, p.contactId), before,
      "role, capabilities, mode and accepted_at are untouched");
  } finally { await client.close(); s.close(); }
});

test("crow_add_member: a non-live row still upserts as before", async () => {
  const s = fresh();
  const client = await researchClient(s.dbPath);
  try {
    const p = await seed(s, { mode: "clone", role: "viewer" });
    const r = await client.callTool({
      name: "crow_add_member",
      arguments: { project_id: p.projectId, contact_id: p.contactId, role: "editor" },
    });
    assert.ok(!r.isError, textOf(r));
    const row = await memberRow(s, p.projectId, p.contactId);
    assert.equal(row.role, "editor");
    assert.equal(row.revoked_at, null);
  } finally { await client.close(); s.close(); }
});

test("crow_remove_member: a live row is refused and not revoked", async () => {
  const s = fresh();
  const client = await researchClient(s.dbPath);
  try {
    const p = await seed(s, { mode: "live", role: "editor" });
    const before = await memberRow(s, p.projectId, p.contactId);

    const r = await client.callTool({
      name: "crow_remove_member",
      arguments: { project_id: p.projectId, contact_id: p.contactId },
    });

    assert.equal(r.isError, true, "the tool refuses");
    assert.match(textOf(r), REFUSAL);
    assert.deepEqual(await memberRow(s, p.projectId, p.contactId), before, "not revoked");
    const audits = (await s.db.execute({
      sql: "SELECT action FROM project_audit_log WHERE project_id = ?", args: [p.projectId],
    })).rows;
    assert.equal(audits.length, 0);
  } finally { await client.close(); s.close(); }
});

test("crow_remove_member: a non-live row is still revoked", async () => {
  const s = fresh();
  const client = await researchClient(s.dbPath);
  try {
    const p = await seed(s, { mode: "clone", role: "editor" });
    const r = await client.callTool({
      name: "crow_remove_member",
      arguments: { project_id: p.projectId, contact_id: p.contactId },
    });
    assert.ok(!r.isError, textOf(r));
    assert.notEqual((await memberRow(s, p.projectId, p.contactId)).revoked_at, null);
  } finally { await client.close(); s.close(); }
});

/* ----------------------------------------------- crow_share's clone path */

const { registerShareInboxTools } = await import("../servers/sharing/tools/share-inbox.js");

/** The share tools with a fake MCP server, a dead peer and a bundle stub. */
function shareTools(db, { onBundle } = {}) {
  const handlers = {};
  registerShareInboxTools({ tool: (name, _d, _s, h) => { handlers[name] = h; } }, {
    db,
    identity: { crowId: "crow:self" },
    peerManager: { isConnected: () => false, send() { throw new Error("offline"); } },
    buildProjectCloneBundle: async () => {
      onBundle?.();
      return { sources: [], notes: [], backends: [], file_manifest: [] };
    },
  });
  return handlers;
}

test("crow_share (project clone): a live row is refused before anything is built or written", async () => {
  const s = fresh();
  try {
    const p = await seed(s, { mode: "live", role: "viewer" });
    const before = await memberRow(s, p.projectId, p.contactId);
    let built = 0;
    const handlers = shareTools(s.db, { onBundle: () => { built += 1; } });

    const r = await handlers.crow_share({
      contact: p.crowId, share_type: "project", item_id: p.projectId,
      permissions: "read", confirm_token: "",
    });

    assert.equal(r.isError, true, "the share refuses");
    assert.match(r.content[0].text, REFUSAL);
    assert.equal(built, 0, "the bundle was never built");
    assert.deepEqual(await memberRow(s, p.projectId, p.contactId), before, "the live row is untouched");
    const shares = (await s.db.execute("SELECT id FROM shared_items")).rows;
    assert.equal(shares.length, 0, "no share row was recorded");
  } finally { s.close(); }
});

test("crow_share (project clone): a non-live row still records the clone share", async () => {
  const s = fresh();
  const prev = process.env.CROW_SKIP_CONFIRM_GATES;
  process.env.CROW_SKIP_CONFIRM_GATES = "1";
  try {
    const p = await seed(s, { mode: "clone", role: "viewer" });
    const handlers = shareTools(s.db);

    const r = await handlers.crow_share({
      contact: p.crowId, share_type: "project", item_id: p.projectId,
      permissions: "read", mode: "clone", role: "editor", confirm_token: "",
    });

    assert.ok(!r.isError, r.content[0].text);
    const row = await memberRow(s, p.projectId, p.contactId);
    assert.equal(row.mode, "clone");
    assert.equal(row.role, "editor");
    const shares = (await s.db.execute("SELECT share_type, mode FROM shared_items")).rows;
    assert.equal(shares.length, 1, "the clone share is still recorded");
  } finally {
    if (prev === undefined) delete process.env.CROW_SKIP_CONFIRM_GATES;
    else process.env.CROW_SKIP_CONFIRM_GATES = prev;
    s.close();
  }
});