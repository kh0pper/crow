import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDocx } from "../bundles/workspace/server/ooxml/docx-model.js";
import { listComments, readCommentThreads, replyComment } from "../bundles/workspace/server/ooxml/docx-comments.js";
import { commentDocx } from "./helpers/workspace-comment-docx.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");
// Captured from the code before readCommentThreads existed.
const PINNED = '[{"id":"0","author":"Sam","date":"2026-10-03T23:42:10Z","content":"¿Con salsa verde?","quoted_text":" con piña y jalapeño.","resolved":false,"replies":[]}]';
const two = () => commentDocx({
  threads: [
    { author: "admin", date: "2026-10-01T10:00:00Z", text: "first", quoted: "con", durableId: "00FB03AF", replies: [{ author: "coworker", date: "2026-10-01T11:00:00Z", text: "re: first" }] },
    { author: "coworker", date: "2026-10-02T10:00:00Z", text: "second", quoted: "con", durableId: "1A2B3C4D", resolved: true },
  ],
  people: { admin: "ocinst_admin", coworker: "ocinst_coworker" },
});

test("durableId by the root's last paraId; replies carry none", () => {
  const { threads } = readCommentThreads(openDocx(two()));
  assert.equal(threads.length, 2);
  assert.equal(threads[0].durableId, "00FB03AF");
  assert.equal(threads[1].durableId, "1A2B3C4D");
  assert.equal(threads[1].resolved, true);
  assert.deepEqual(threads[0].replies, [{ author: "coworker", date: "2026-10-01T11:00:00Z", text: "re: first" }]);
  assert.equal(threads[0].author, "admin");
  assert.equal(threads[0].date, "2026-10-01T10:00:00Z");
  assert.equal(threads[0].text, "first");
});

test("people.xml maps author -> w15:userId", () => {
  const { people } = readCommentThreads(openDocx(two()));
  assert.ok(people instanceof Map);
  assert.equal(people.get("admin"), "ocinst_admin");
  assert.equal(people.get("coworker"), "ocinst_coworker");
});

test("no commentsIds / people parts -> durableId null, empty map", () => {
  const d = openDocx(commentDocx({ threads: [{ author: "admin", date: "2026-10-01T10:00:00Z", text: "x", quoted: "con" }] }));
  const r = readCommentThreads(d);
  assert.equal(r.threads[0].durableId, null);
  assert.equal(r.people.size, 0);
});

test("listComments output is byte-identical to before", () => {
  assert.equal(JSON.stringify(listComments(openDocx(readFileSync(join(FIX, "oo-rich.docx"))))), PINNED);
});

test("close-time writers keep existing durableIds (addDurableRows only appends)", () => {
  const d = openDocx(two());
  const before = readCommentThreads(d).threads.map((t) => t.durableId);
  replyComment(d, "0", "another", { author: "admin", initials: "A" });
  const after = readCommentThreads(openDocx(Buffer.from(d.pkg.save())));
  assert.deepEqual(after.threads.map((t) => t.durableId), before);
  assert.equal(after.threads[0].replies.length, 2);
});

test("a real ONLYOFFICE save maps its root durableId (guards the reader against the self-built helper)", () => {
  const { threads, people } = readCommentThreads(openDocx(readFileSync(join(FIX, "oo-rich.docx"))));
  assert.equal(threads.length, 1);
  assert.equal(threads[0].durableId, "32B882E4");
  assert.equal(threads[0].author, "Sam");
  assert.equal(people.size, 0, "this fixture has no people.xml");
});
