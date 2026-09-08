import { test } from "node:test";
import assert from "node:assert/strict";
import { keyTail, labelFor, cawTitleFor } from "../bundles/ramble/server/labels.js";

const A = "f665c26b" + "0".repeat(56);
test("labelFor: own > contact > named stranger with key4 > key8; caws use their noun", () => {
  assert.equal(labelFor({ kind: "mark", origin: "local", author: A }), "your mark");
  assert.equal(labelFor({ kind: "caw", origin: "sync", author: A, author_name: "Kevin" }), "your caw");
  assert.equal(labelFor({ kind: "mark", origin: "remote", author: A, author_name: "Kevin" }, { contactName: "Pal" }), "mark by Pal");
  assert.equal(labelFor({ kind: "caw", origin: "remote", author: A, author_name: "Kevin" }), "caw by Kevin · f665");
  assert.equal(labelFor({ kind: "mark", origin: "remote", author: A }), "mark by f665c26b");
  assert.equal(labelFor({ kind: "mark", origin: "remote" }), "mark by anon");
  assert.equal(keyTail(A, 4), "f665");
  assert.equal(keyTail(null, 8), "anon");
});
test("cawTitleFor mirrors the rule for the AR title", () => {
  assert.equal(cawTitleFor({ kind: "caw", origin: "local", author: A }), "Your caw");
  assert.equal(cawTitleFor({ kind: "caw", origin: "remote", author: A }, { contactName: "Pal" }), "A caw from Pal");
  assert.equal(cawTitleFor({ kind: "caw", origin: "remote", author: A, author_name: "Kevin" }), "A caw from Kevin · f665");
  assert.equal(cawTitleFor({ kind: "caw", origin: "remote", author: A }), "A caw");
});
