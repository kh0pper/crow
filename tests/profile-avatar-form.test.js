/**
 * Spec 2026-09-08 §4.1 (the My profile form + save), §4.6 (the guide).
 * Render assertions on the real html/client/css builders; the save handler on
 * a real init-db schema with the settings sync manager unset and injected
 * managers (a sendControl spy stands in for the Nostr manager).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { renderMyProfile } from "../servers/gateway/dashboard/panels/contacts/html.js";
import { contactsClientJs } from "../servers/gateway/dashboard/panels/contacts/client.js";
import { contactsCss } from "../servers/gateway/dashboard/panels/contacts/css.js";
import { handleContactAction } from "../servers/gateway/dashboard/panels/contacts/api-handlers.js";
import { getMyProfile } from "../servers/gateway/dashboard/panels/contacts/data-queries.js";
import { setSettingsSyncManager } from "../servers/gateway/dashboard/settings/registry.js";
import { AVATAR_MAX_BYTES } from "../servers/sharing/avatar.js";
import { renderBirdAvatar } from "../servers/sharing/profile-avatar.js";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const PNG = "data:image/png;base64," + "A".repeat(64);
const REPO = join(import.meta.dirname, "..");

test("renderMyProfile: file input + hidden data field capped by data-max; the bird radios only with a bird; remove-picture only with a picture; a legacy URL never renders", () => {
  const base = renderMyProfile({ display_name: "Kevin", avatar_url: "", bio: "", avatar_source: "picture" }, "en");
  assert.match(base, /<input type="file" id="profilePictureInput"[^>]*data-max="32768"/);
  assert.equal(AVATAR_MAX_BYTES, 32768);
  assert.ok(base.includes('<input type="hidden" name="avatar" id="profileAvatarData" value="">'));
  assert.ok(!base.includes('name="avatar_url"'), "the URL text field is gone from My profile");
  assert.ok(!base.includes('name="avatar_source"'), "no source field without a bird");
  assert.ok(!base.includes('name="avatar_clear"'), "nothing to remove");
  assert.ok(base.includes('data-too-big="' + t("contacts.pictureTooBig", "en") + '"'));
  assert.ok(base.includes('onchange="readProfilePicture(this)"'));

  const withPic = renderMyProfile({ display_name: "Kevin", avatar_url: PNG, bio: "", avatar_source: "picture" }, "en", { birdAvailable: true });
  assert.ok(withPic.includes('<img src="' + PNG + '" alt="">'), "the preview renders the inline picture");
  assert.ok(withPic.includes('name="avatar_clear" value="1"'));
  assert.match(withPic, /name="avatar_source" value="picture" checked/);
  assert.match(withPic, /name="avatar_source" value="bird">/);
  const bird = renderMyProfile({ display_name: "K", avatar_url: PNG, bio: "", avatar_source: "bird" }, "es", { birdAvailable: true });
  assert.match(bird, /name="avatar_source" value="bird" checked/);
  assert.ok(bird.includes(t("contacts.sourceBird", "es")));

  const legacy = renderMyProfile({ display_name: "Kevin", avatar_url: "https://example.com/me.png", bio: "" }, "en");
  assert.ok(!legacy.includes("https://example.com/me.png"), "a URL is not rendered anywhere");
  assert.ok(legacy.includes(">KE<"), "initials instead");
});

test("contacts client script: the picture reader has no backticks, no interpolation, no markup sinks; the css carries the new rules", () => {
  const js = contactsClientJs();
  assert.ok(!js.includes("`"), "zero backticks inside the script");
  assert.ok(!js.includes("${"), "zero template interpolation");
  assert.deepEqual(js.match(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML|document\.write/g) || [], [], "zero markup sinks");
  for (const pin of [
    "function readProfilePicture(input)", "getAttribute('data-max')", "canvas.toDataURL('image/jpeg', 0.82)",
    "canvas.toDataURL('image/png')", "function flattenedJpeg(canvas, size, quality)", "function showProfilePreview(dataUri)",
    "img.src = dataUri", "hidden.value = out", "var size = 128;", "if (data[i] < 255) { transparent = true; break; }",
  ]) assert.ok(js.includes(pin), pin);
  const css = contactsCss();
  for (const sel of [".my-profile-hint", ".my-profile-msg", ".my-profile-source", ".my-profile-check", "#profilePictureInput"]) assert.ok(css.includes(sel), sel);
});

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "profile-form-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir; // deleteLocalSetting resolves the local instance id from here
  setSettingsSyncManager(null);
  return {
    db,
    cleanup() {
      try { db.close(); } catch {}
      setSettingsSyncManager(null);
      if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const save = async (db, body, managers) => {
  const out = await handleContactAction({ body: { action: "save_profile", ...body } }, db, { managers });
  if (out?.broadcast) await out.broadcast; // the fan-out is fire-and-forget in production (R2-S4)
  return out;
};
const seedPal = (db) => db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:pal', 'Pal', ?, ?)", args: ["d".repeat(64), "02" + "a".repeat(64)] });
const spyMgrs = (db, sent) => ({ db, nostrManager: { sendControl: async (c, content) => { sent.push(JSON.parse(content)); return { eventId: "e", relays: ["r"] }; } } });

test("save_profile: a valid data URI is stored globally; junk is a 400; clear empties; an unknown source is a 400; ONE broadcast per changed save, none for an unchanged one", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedPal(db);
    const sent = [];
    const managers = spyMgrs(db, sent);

    let out = await save(db, { display_name: "Kevin", avatar: PNG, bio: "hi" }, managers);
    assert.equal(out.redirect, "/dashboard/contacts?view=profile");
    let p = await getMyProfile(db);
    assert.equal(p.avatar_url, PNG);
    assert.equal(p.avatar_source, "picture");
    assert.equal(sent.length, 1, "one broadcast");
    assert.deepEqual(sent[0].payload, { v: 1, display_name: "Kevin", avatar: PNG });

    out = await save(db, { display_name: "Kevin", avatar: "", bio: "hi" }, managers);
    assert.equal(sent.length, 1, "nothing changed (an empty avatar field means untouched) -> no broadcast");
    assert.equal((await getMyProfile(db)).avatar_url, PNG);

    out = await save(db, { avatar: "https://example.com/me.png" }, managers);
    assert.equal(out.status, 400);
    assert.match(out.text, /data:image/);
    assert.equal((await getMyProfile(db)).avatar_url, PNG, "a rejected save changes nothing");
    out = await save(db, { avatar: "data:image/png;base64," + "A".repeat(40000) }, managers);
    assert.equal(out.status, 400);
    out = await save(db, { avatar_source: "hat" }, managers);
    assert.equal(out.status, 400);
    assert.equal(sent.length, 1);

    out = await save(db, { display_name: "Kevin", avatar_clear: "1" }, managers);
    p = await getMyProfile(db);
    assert.equal(p.avatar_url, "", "cleared");
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].payload, { v: 1, display_name: "Kevin", avatar: null }, "a removed picture propagates as null");

    const o = await db.execute("SELECT COUNT(*) AS c FROM dashboard_settings_overrides WHERE key LIKE 'profile_%'");
    assert.equal(Number(o.rows[0].c), 0, "no stranded overrides (D2)");
    assert.equal((await save(db, { display_name: "Kevin" }, null)).redirect, "/dashboard/contacts?view=profile", "no managers: saves, no broadcast, no throw");
  } finally { cleanup(); }
});

test("save_profile: the response does not wait for the fan-out, and a fan-out that failed is re-sent by the next save even when nothing changed (R2-S3/S4)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedPal(db);
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = { db, nostrManager: { sendControl: async () => { await gate; return { eventId: "e", relays: ["r"] }; } } };
    const out = await handleContactAction({ body: { action: "save_profile", display_name: "Kevin", avatar: PNG } }, db, { managers: slow });
    assert.equal(out.redirect, "/dashboard/contacts?view=profile", "redirect returned while the relay is still hanging");
    assert.ok(out.broadcast instanceof Promise);
    release();
    assert.deepEqual(await out.broadcast, { sent: 1, failed: 0, skipped: 0 });

    const down = { db, nostrManager: { sendControl: async () => { throw new Error("relay down"); } } };
    assert.deepEqual(await (await handleContactAction({ body: { action: "save_profile", display_name: "Kevin2" } }, db, { managers: down })).broadcast, { sent: 0, failed: 1, skipped: 0 });
    const sent = [];
    const up = spyMgrs(db, sent);
    await save(db, { display_name: "Kevin2" }, up); // unchanged profile
    assert.equal(sent.length, 1, "re-sent because the last fan-out was pending");
    assert.deepEqual(sent[0].payload, { v: 1, display_name: "Kevin2", avatar: PNG });
    await save(db, { display_name: "Kevin2" }, up);
    assert.equal(sent.length, 1, "delivered once, quiet afterwards");
  } finally { cleanup(); }
});

test("the panel handler renders a 400 inside the dashboard layout, not as a bare string (R1-S2)", async () => {
  const { db, cleanup } = freshDb();
  try {
    const { default: panel } = await import("../servers/gateway/dashboard/panels/contacts.js");
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; }, redirectAfterPost() { throw new Error("unexpected redirect"); } };
    await panel.handler({ method: "POST", body: { action: "save_profile", avatar: "https://example.com/me.png" }, query: {} }, res, {
      db, lang: "en", layout: ({ title, content }) => "<html><title>" + title + "</title>" + content + "</html>",
    });
    assert.equal(res.code, 400);
    assert.ok(res.body.startsWith("<html>"), "wrapped by the layout");
    assert.ok(res.body.includes("data:image/") && res.body.includes('href="/dashboard/contacts?view=profile"'));
  } finally { cleanup(); }
});

test("save_profile with avatar_source=bird renders the active bird into the picture and broadcasts; with no bird the source falls back to picture", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedPal(db);
    const sent = [];
    const managers = spyMgrs(db, sent);
    await save(db, { avatar: PNG }, managers);
    assert.equal(sent.length, 1);

    await save(db, { avatar_source: "bird" }, managers);
    let p = await getMyProfile(db);
    assert.equal(p.avatar_source, "picture", "no bird: silent fallback");
    assert.equal(p.avatar_url, PNG, "the stored picture stays");
    assert.equal(sent.length, 1, "nothing changed, nothing sent");

    await initRambleTables(db);
    await db.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES ('b1', 'hatched', 100, 'hummingbird', 77, 1, 2)");
    await db.execute("INSERT INTO ramble_pet (owner, active_egg_id) VALUES ('self', 'b1')");
    await save(db, { avatar_source: "bird" }, managers);
    p = await getMyProfile(db);
    assert.equal(p.avatar_source, "bird");
    assert.equal(p.avatar_url, renderBirdAvatar({ species: "hummingbird", seed: 77 }));
    assert.equal(sent.length, 2, "one broadcast for the bird");
    assert.equal(sent[1].payload.avatar, p.avatar_url);

    await save(db, { avatar_source: "picture" }, managers);
    p = await getMyProfile(db);
    assert.equal(p.avatar_source, "picture");
    assert.equal(p.avatar_url, renderBirdAvatar({ species: "hummingbird", seed: 77 }), "back to picture keeps the last stored image");
    assert.equal(sent.length, 3, "the source change alone is a change");
  } finally { cleanup(); }
});

test("edit_contact bounds avatar_url: an inline avatar or a short URL is stored, junk and oversize are a 400 (R2-S5)", async () => {
  const { db, cleanup } = freshDb();
  try {
    const id = Number((await db.execute("INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:ed', 'Ed', '', '')")).lastInsertRowid);
    const edit = (avatar_url) => handleContactAction({ body: { action: "edit_contact", contact_id: String(id), avatar_url } }, db, { managers: null });
    const stored = async () => (await db.execute({ sql: "SELECT avatar_url FROM contacts WHERE id = ?", args: [id] })).rows[0].avatar_url;
    assert.ok((await edit(PNG)).redirect);
    assert.equal(await stored(), PNG);
    assert.ok((await edit("https://example.com/me.png")).redirect);
    assert.equal(await stored(), "https://example.com/me.png");
    assert.equal((await edit("javascript:alert(1)")).status, 400);
    assert.equal((await edit("data:image/png;base64," + "A".repeat(40000))).status, 400);
    assert.equal(await stored(), "https://example.com/me.png", "a refused edit changes nothing");
    assert.ok((await edit("")).redirect);
    assert.equal(await stored(), "");
  } finally { cleanup(); }
});

test("docs: the contacts guide points at Contacts > My Profile, never Settings > Identity; en/es heading parity", () => {
  const en = readFileSync(join(REPO, "docs/guide/contacts.md"), "utf8");
  const es = readFileSync(join(REPO, "docs/es/guide/contacts.md"), "utf8");
  assert.ok(en.includes("**Contacts** > **My Profile**"));
  assert.ok(!en.includes("**Settings** > **Identity**"));
  assert.ok(es.includes("**Contactos** > **Mi perfil**"));
  assert.ok(!es.includes("**Ajustes** > **Identidad**"));
  assert.ok(en.includes("128 px") && es.includes("128 px"));
  const levels = (s) => s.split("\n").filter((l) => /^#{2,3} /.test(l)).map((l) => l.split(" ")[0]);
  assert.deepEqual(levels(es), levels(en), "en/es contacts guides keep the same heading structure");
});
