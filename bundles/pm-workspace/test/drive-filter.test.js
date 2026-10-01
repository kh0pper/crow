import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMailIgnore as parseIgnore } from "../server/digest/adapters/outlook.js";
import { filterDriveFiles, collectDriveFiles } from "../server/digest/adapters/google.js";

const mine = (name) => ({ name, owners: [{ emailAddress: "me@example.org" }] });
const theirs = (name) => ({ name, owners: [{ emailAddress: "someone@other-district.example" }] });

const FILES = [mine("notes.md"), theirs("Shared intake form.pdf"), mine("backup-20260101.tar.gz"), { name: "no owners listed" }];

test("empty or unset DRIVE_IGNORE keeps every file", () => {
  assert.deepEqual(filterDriveFiles(FILES, parseIgnore(undefined)), FILES);
  assert.deepEqual(filterDriveFiles(FILES, parseIgnore("")), FILES);
  assert.deepEqual(filterDriveFiles(FILES, parseIgnore(" ; ")), FILES);
});

test("a pattern matches an owner's email address, case-insensitively", () => {
  const out = filterDriveFiles(FILES, parseIgnore("OTHER-DISTRICT.example"));
  assert.deepEqual(out.map((f) => f.name), ["notes.md", "backup-20260101.tar.gz", "no owners listed"]);
});

test("patterns match the file name too, and several patterns combine", () => {
  const out = filterDriveFiles(FILES, parseIgnore("other-district\\.example$; ^backup-.*\\.tar\\.gz$"));
  assert.deepEqual(out.map((f) => f.name), ["notes.md", "no owners listed"]);
});

test("files without a name or owners survive when nothing matches", () => {
  const out = filterDriveFiles([{}, { name: null, owners: null }, { owners: [{}] }], parseIgnore("anything"));
  assert.equal(out.length, 3);
});

test("ignored files cannot crowd kept files out: pages are followed until the limit is met", async () => {
  const pages = {
    undefined: { files: Array.from({ length: 5 }, (_, i) => theirs(`shared-${i}`)), nextPageToken: "p2" },
    p2: { files: [mine("a"), theirs("shared-x"), mine("b")], nextPageToken: "p3" },
    p3: { files: [mine("c"), mine("d")] },
  };
  const calls = [];
  const fetchPage = async (token) => {
    calls.push(token);
    return pages[token];
  };
  const out = await collectDriveFiles(fetchPage, parseIgnore("other-district"), 3, 5);
  assert.deepEqual(out.map((f) => f.name), ["a", "b", "c"]);
  assert.deepEqual(calls, [undefined, "p2", "p3"]);
});

test("paging stops at the limit, at the last page, and at maxPages", async () => {
  let n = 0;
  const endless = async () => ({ files: [theirs(`s-${n++}`)], nextPageToken: "more" });
  assert.deepEqual(await collectDriveFiles(endless, parseIgnore("other-district"), 10, 4), []);
  assert.equal(n, 4);

  let calls = 0;
  const one = async () => {
    calls++;
    return { files: [mine("a"), mine("b"), mine("c")], nextPageToken: "more" };
  };
  const out = await collectDriveFiles(one, [], 2, 1);
  assert.deepEqual(out.map((f) => f.name), ["a", "b"]);
  assert.equal(calls, 1);

  assert.deepEqual(await collectDriveFiles(async () => undefined, [], 5, 3), []);
});
