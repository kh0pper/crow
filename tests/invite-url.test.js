// tests/invite-url.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INVITE_PAGE_URL,
  invitePageBase,
  buildInviteUrl,
  extractInviteCode,
} from "../servers/sharing/invite-url.js";

const CODE = "crow:abc123def0.eyJmYWtlIjoxfQ.c2ln"; // shape: crowId.payload.hmac

test("default base is the product invite page", () => {
  assert.equal(DEFAULT_INVITE_PAGE_URL, "https://maestro.press/software/crow/invite/");
  assert.equal(invitePageBase({}), DEFAULT_INVITE_PAGE_URL);
});

test("CROW_INVITE_PAGE_URL overrides the base (trimmed, fragment stripped)", () => {
  assert.equal(invitePageBase({ CROW_INVITE_PAGE_URL: " https://my.site/inv " }), "https://my.site/inv");
  assert.equal(invitePageBase({ CROW_INVITE_PAGE_URL: "https://my.site/inv#old" }), "https://my.site/inv");
  assert.equal(invitePageBase({ CROW_INVITE_PAGE_URL: "" }), DEFAULT_INVITE_PAGE_URL);
});

test("buildInviteUrl puts the code in the fragment, encoded", () => {
  const url = buildInviteUrl(CODE, {});
  assert.equal(url, `${DEFAULT_INVITE_PAGE_URL}#${encodeURIComponent(CODE)}`);
  assert.ok(!url.includes("?"), "no query string — fragment only");
});

test("extractInviteCode: raw code passes through trimmed", () => {
  assert.equal(extractInviteCode(`  ${CODE}\n`), CODE);
});

test("extractInviteCode: full invite URL yields the code", () => {
  assert.equal(extractInviteCode(buildInviteUrl(CODE, {})), CODE);
});

test("extractInviteCode: percent-encoded fragment is decoded", () => {
  assert.equal(extractInviteCode(`https://x/inv#${encodeURIComponent(CODE)}`), CODE);
});

test("extractInviteCode: edge cases never throw", () => {
  assert.equal(extractInviteCode(null), "");
  assert.equal(extractInviteCode(undefined), "");
  assert.equal(extractInviteCode(""), "");
  assert.equal(extractInviteCode("https://x/inv#"), "");
  assert.equal(extractInviteCode("no-hash-here"), "no-hash-here");
  // Bad percent-encoding: falls back to the raw fragment, does not throw.
  assert.equal(extractInviteCode("https://x/inv#%E0%A4%A"), "%E0%A4%A");
});
