/**
 * The viewer's comment chip says when the author is a bot: "<id> · bot".
 * Owner ("you") and contact chips are unchanged; the chip gets its own style.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const REPO = new URL("..", import.meta.url).pathname;
const src = readFileSync(REPO + "bundles/artifacts/panel/static/viewer-client.js", "utf8");
const css = readFileSync(REPO + "bundles/artifacts/panel/static/viewer.css", "utf8");
const line = src.split("\n").find((l) => l.includes("function authorName"));

function load(T) {
  return new Function("T", line + "\nreturn authorName;")(T);
}

test("authorName: bot chip is '<id> · <T.bot>'; owner and contact unchanged", () => {
  assert.ok(line, "authorName is defined");
  const authorName = load({ you: "you", bot: "bot" });
  assert.equal(authorName({ author_kind: "bot", author_id: "hank" }), "hank · bot");
  assert.equal(authorName({ author_kind: "owner" }), "you");
  assert.equal(authorName({ author_kind: "contact", author_id: "alex" }), "alex");
  assert.equal(load({ you: "tú", bot: "bot" })({ author_kind: "bot", author_id: "hank" }), "hank · bot");
  assert.equal(authorName({ author_kind: "bot" }), "bot");
});

test("viewer.css styles the bot chip", () => {
  assert.match(css, /\.cv-c\.cv-bot \.cv-chip\s*\{/);
  assert.ok(!src.includes("`") || !line.includes("`"));
});
