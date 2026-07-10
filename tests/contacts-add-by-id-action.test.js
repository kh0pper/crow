/**
 * contacts-add-by-id-action — R4 Task 4. The Contacts panel add_by_id action
 * calls the crow_add_contact tool with the pasted keys (via an injected
 * sharing-client factory) and redirects. Asserts the tool is called with the
 * normalized args and that a missing crow_id/secp key is a safe no-op redirect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleContactAction } from "../servers/gateway/dashboard/panels/contacts/api-handlers.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "addbyid-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

function stubFactory(record) {
  return async () => ({
    callTool: async ({ name, arguments: args }) => { record.push({ name, args }); return { content: [{ type: "text", text: "ok" }] }; },
    close: async () => {},
  });
}

test("add_by_id calls crow_add_contact with the pasted keys", async () => {
  const { db, cleanup } = freshDb();
  try {
    const calls = [];
    const req = { body: { action: "add_by_id", crow_id: "crow:peer1", secp256k1_pubkey: "02" + "a".repeat(64), ed25519_pubkey: "b".repeat(64), name: "Peer" } };
    const out = await handleContactAction(req, db, { sharingClientFactory: stubFactory(calls) });
    assert.ok(out && out.redirect, "returns a redirect");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "crow_add_contact");
    assert.equal(calls[0].args.crow_id, "crow:peer1");
    assert.equal(calls[0].args.secp256k1_pubkey, "02" + "a".repeat(64));
  } finally { cleanup(); }
});

test("add_by_id with a missing key is a safe no-op redirect (no tool call)", async () => {
  const { db, cleanup } = freshDb();
  try {
    const calls = [];
    const req = { body: { action: "add_by_id", crow_id: "", secp256k1_pubkey: "" } };
    const out = await handleContactAction(req, db, { sharingClientFactory: stubFactory(calls) });
    assert.ok(out && out.redirect);
    assert.equal(calls.length, 0);
  } finally { cleanup(); }
});

test("add_by_id surfaces a tool refusal instead of silently redirecting (F-UI-1/3 addendum)", async () => {
  const { db, cleanup } = freshDb();
  try {
    // R1-I2: the real signature is handleContactAction(req, db, { sharingClientFactory } = {})
    // (contacts/api-handlers.js:38) — pass the stub IN AN OPTIONS OBJECT or it is
    // silently ignored and the test hits the real sharing runtime.
    const stubFactory = async () => ({
      callTool: async () => ({
        isError: true,
        content: [{ type: "text", text: "Failed to add contact: already exists with a different key" }],
      }),
      close: async () => {},
    });
    const req = { body: { action: "add_by_id", crow_id: "crow:peer1", secp256k1_pubkey: "02" + "a".repeat(64) } };
    const result = await handleContactAction(req, db, { sharingClientFactory: stubFactory });
    assert.equal(result.redirect, undefined);
    assert.match(result.inviteError, /different key/);
  } finally { cleanup(); }
});

test("add_by_id success still redirects", async () => {
  const { db, cleanup } = freshDb();
  try {
    const calls = [];
    const req = { body: { action: "add_by_id", crow_id: "crow:peer1", secp256k1_pubkey: "02" + "a".repeat(64) } };
    const out = await handleContactAction(req, db, { sharingClientFactory: stubFactory(calls) });
    assert.equal(out.redirect, "/dashboard/contacts?flash=peer_added");
  } finally { cleanup(); }
});
