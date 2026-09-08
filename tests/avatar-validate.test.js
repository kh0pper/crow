import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAvatar, avatarFieldValue, AVATAR_MAX_BYTES, AVATAR_RE } from "../servers/sharing/avatar.js";

const PREFIX = "data:image/png;base64,";

test("validateAvatar: typed base64 data URIs under the cap pass unchanged; everything else is null", () => {
  const png = PREFIX + "A".repeat(100);
  assert.equal(validateAvatar(png), png);
  assert.equal(validateAvatar("data:image/jpeg;base64,/9j/4AAQ=="), "data:image/jpeg;base64,/9j/4AAQ==");
  assert.equal(validateAvatar("data:image/webp;base64,UklGRg=="), "data:image/webp;base64,UklGRg==");
  assert.equal(validateAvatar("data:image/svg+xml;base64,PHN2Zz4="), "data:image/svg+xml;base64,PHN2Zz4=");
  assert.equal(validateAvatar("https://example.com/a.png"), null, "a URL is not an avatar");
  assert.equal(validateAvatar("data:image/gif;base64,R0lGOD"), null, "gif is not in the type list");
  assert.equal(validateAvatar("data:text/html;base64,PHNjcmlwdD4="), null, "only image types");
  assert.equal(validateAvatar("data:image/png;base64,<script>"), null, "not base64");
  assert.equal(validateAvatar("data:image/png,rawpng"), null, "the base64 marker is required");
  assert.equal(validateAvatar("DATA:image/png;base64,AAAA"), null, "case-exact scheme");
  assert.equal(validateAvatar(PREFIX + "AAAA\n"), null, "no trailing newline");
  assert.equal(validateAvatar(""), null);
  assert.equal(validateAvatar(null), null);
  assert.equal(validateAvatar(undefined), null);
  assert.equal(validateAvatar(42), null);
  assert.equal(validateAvatar({ toString: () => png }), null, "strings only");
});

test("validateAvatar: the cap is inclusive and counts the whole string", () => {
  const atCap = PREFIX + "A".repeat(AVATAR_MAX_BYTES - PREFIX.length);
  assert.equal(atCap.length, AVATAR_MAX_BYTES);
  assert.equal(validateAvatar(atCap), atCap, "exactly the cap passes");
  assert.equal(validateAvatar(atCap + "A"), null, "one over the cap is rejected");
  assert.equal(AVATAR_MAX_BYTES, 32768);
  assert.ok(AVATAR_RE instanceof RegExp);
  assert.equal(AVATAR_RE.test("data:image/svg+xml;base64,PHN2Zz4="), true);
});

test("avatarFieldValue (the contact editor's avatar_url): empty, an inline avatar, or a short http(s) URL; junk and oversize are null", () => {
  assert.equal(avatarFieldValue(""), "");
  assert.equal(avatarFieldValue("   "), "", "whitespace is empty");
  assert.equal(avatarFieldValue(PREFIX + "AAAA"), PREFIX + "AAAA");
  assert.equal(avatarFieldValue("https://example.com/me.png"), "https://example.com/me.png", "a legacy URL is kept (it cannot render, but it is the user's)");
  assert.equal(avatarFieldValue("http://example.com/me.png"), "http://example.com/me.png");
  assert.equal(avatarFieldValue("https://example.com/" + "a".repeat(2048)), null, "over 2048 characters");
  assert.equal(avatarFieldValue("javascript:alert(1)"), null);
  assert.equal(avatarFieldValue("data:text/html;base64,PHNjcmlwdD4="), null);
  assert.equal(avatarFieldValue(PREFIX + "A".repeat(AVATAR_MAX_BYTES)), null, "an oversize inline picture is refused, not stored");
  assert.equal(avatarFieldValue(null), null);
  assert.equal(avatarFieldValue(7), null);
});
