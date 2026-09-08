/**
 * Spec 2026-09-08 §4.5 (D5): everywhere the Contacts panel and the Messages
 * list show a contact, a typed name/picture wins, a placeholder yields to what
 * the peer sent, and the crow id is the last resort.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { renderContactList, renderContactProfile, renderDeleteConfirm, renderGroupManager } from "../servers/gateway/dashboard/panels/contacts/html.js";
import { getUnifiedConversationList } from "../servers/gateway/dashboard/panels/messages/data-queries.js";

const PNG = "data:image/png;base64," + "A".repeat(64);
const base = { id: 7, contact_type: "crow", crow_id: "crow:abcd1234", ed25519_pubkey: "b".repeat(64), secp256k1_pubkey: "02" + "c".repeat(64), verified: 0, group_ids: null };
const preview = { messages: 0, sharedItems: 0, groups: 0, projectsOwned: 0, projectMemberships: 0 };

test("a placeholder local name + a peer name/picture: the list, the profile, the delete interstitial and the group roster show the peer's", () => {
  const peer = { ...base, display_name: "crow:abcd1234", peer_display_name: "Kevin", peer_avatar: PNG };
  const list = renderContactList([peer], [], {}, "en", {});
  assert.ok(list.includes('contact-card-name">Kevin'), "card name");
  assert.ok(list.includes('data-name="kevin"'), "client-side search key");
  assert.ok(list.includes('<img src="' + PNG + '"'), "card picture");
  const profile = renderContactProfile(peer, [], [], [], "en", "");
  assert.ok(profile.includes("<h2>Kevin</h2>"));
  assert.ok(profile.includes('<img src="' + PNG + '"'));
  assert.ok(!profile.includes("Their name"), "no separate row when the peer name is what is shown");
  const del = renderDeleteConfirm(peer, preview, "en", "");
  assert.ok(del.includes("<h2>Kevin</h2>"));
  const groups = renderGroupManager([{ id: 1, name: "G", member_count: 1 }], [{ ...peer, group_ids: "1" }], "en");
  assert.ok(groups.includes('title="Kevin"'));
  assert.ok(groups.includes('<img src="' + PNG + '"'));
});

test("a typed local name wins and the peer's own name is shown as a detail row; a typed picture beats the peer's; no peer fields = today", () => {
  const typed = { ...base, display_name: "My Friend", avatar_url: "data:image/jpeg;base64," + "B".repeat(64), peer_display_name: "Kevin", peer_avatar: PNG };
  const profile = renderContactProfile(typed, [], [], [], "en", "");
  assert.ok(profile.includes("<h2>My Friend</h2>"));
  assert.ok(profile.includes("Their name") && profile.includes(">Kevin<"), "the peer's name is visible as a detail");
  assert.ok(profile.includes('<img src="data:image/jpeg;base64,' + "B".repeat(64) + '"'));
  assert.ok(!profile.includes(PNG));
  const plain = renderContactProfile({ ...base, display_name: "crow:abcd1234" }, [], [], [], "en", "");
  assert.ok(plain.includes("<h2>crow:abcd1234</h2>"), "no peer fields: the crow id, as today");
  assert.ok(!plain.includes("<img"));
});

test("the Messages conversation list names a peer contact by the display rule", async () => {
  const dir = mkdtempSync(join(tmpdir(), "peer-display-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  try {
    await db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, peer_display_name) VALUES ('crow:peer-named', 'crow:peer-named', ?, ?, 'Kevin'), ('crow:typed-one', 'My Friend', ?, ?, 'Kevin'), ('crow:bare', 'crow:bare', ?, ?, NULL)", args: ["d".repeat(64), "02" + "1".repeat(64), "d".repeat(64), "02" + "2".repeat(64), "d".repeat(64), "02" + "3".repeat(64)] });
    const out = await getUnifiedConversationList(db);
    const items = Array.isArray(out) ? out : out.items;
    const byCrow = (id) => items.find((i) => i.type === "peer" && i.crowId === id);
    assert.equal(byCrow("crow:peer-named")?.displayName, "Kevin");
    assert.equal(byCrow("crow:typed-one")?.displayName, "My Friend");
    assert.equal(byCrow("crow:bare")?.displayName, "crow:bare", "no peer name: the stored placeholder, byte-identical to today");
  } finally { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
});
