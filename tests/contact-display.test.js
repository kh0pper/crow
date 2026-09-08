import { test } from "node:test";
import assert from "node:assert/strict";
import { contactName, contactAvatar, isPlaceholderName } from "../servers/sharing/contact-display.js";
import { isPlaceholderName as promoteRule } from "../servers/sharing/contact-promote.js";

const PNG = "data:image/png;base64," + "A".repeat(40);
const JPG = "data:image/jpeg;base64," + "B".repeat(40);

test("contactName: a typed local name wins; a placeholder yields to the peer's name; then the crow id; then null", () => {
  assert.equal(contactName({ display_name: "My Friend", peer_display_name: "Kevin", crow_id: "crow:abc" }), "My Friend");
  assert.equal(contactName({ display_name: "crow:abc", peer_display_name: "Kevin", crow_id: "crow:abc" }), "Kevin", "the crowId placeholder is not a name");
  assert.equal(contactName({ display_name: "req:ff", peer_display_name: "Kevin", crow_id: "crow:abc" }), "Kevin");
  assert.equal(contactName({ display_name: "", peer_display_name: "Kevin", crow_id: "crow:abc" }), "Kevin");
  assert.equal(contactName({ display_name: null, peer_display_name: "Kevin", crow_id: "crow:abc" }), "Kevin");
  assert.equal(contactName({ display_name: null, peer_display_name: null, crow_id: "crow:abc" }), "crow:abc");
  assert.equal(contactName({ display_name: "crow:abc", peer_display_name: "", crow_id: "crow:abc" }), "crow:abc", "an empty peer name is no name");
  assert.equal(contactName({ display_name: "crow:abc", crow_id: "crow:abc" }, { fallback: "crow:abc..." }), "crow:abc...", "the caller's fallback replaces crow_id");
  assert.equal(contactName({ display_name: "Dayane", crow_id: "crow:abc" }, { fallback: "x" }), "Dayane", "a fallback never beats a name");
  assert.equal(contactName({}), null);
  assert.equal(contactName(null), null);
  assert.equal(contactName(undefined, { fallback: "f" }), "f");
});

test("contactAvatar: the first VALID inline picture wins (local, then peer); a URL never renders", () => {
  assert.equal(contactAvatar({ avatar_url: PNG, peer_avatar: JPG }), PNG);
  assert.equal(contactAvatar({ avatar_url: "", peer_avatar: JPG }), JPG);
  assert.equal(contactAvatar({ avatar_url: null, peer_avatar: JPG }), JPG);
  assert.equal(contactAvatar({ avatar_url: "https://example.com/me.png", peer_avatar: JPG }), JPG, "a legacy URL falls through to the peer's picture");
  assert.equal(contactAvatar({ avatar_url: "https://example.com/me.png" }), null);
  assert.equal(contactAvatar({ peer_avatar: "data:image/png;base64," + "A".repeat(40000) }), null, "over the cap is not a picture");
  assert.equal(contactAvatar({}), null);
  assert.equal(contactAvatar(null), null);
});

test("isPlaceholderName mirrors contact-promote's rule exactly", () => {
  for (const v of [null, undefined, "", "req:x", "crow:y", "Kevin", "  ", "Crow:z", "REQ:q", 0, "0"]) {
    assert.equal(isPlaceholderName(v), promoteRule(v), `disagree on ${JSON.stringify(v)}`);
  }
});
