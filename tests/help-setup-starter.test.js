/**
 * C1/C3 Task 4 — "clear starter content" action on the Help & Setup
 * settings section.
 *
 * render() shows a count of `source='starter'` memories and, when > 0, a
 * confirm-gated POST form (action=help_setup_clear_starter). handleAction()
 * dispatches that action through clearStarterMemories(db) (Task 2/3) —
 * memories only, never the starter bot/conversation.
 *
 * Uses a real init-db database (same harness pattern as
 * tests/sync-conflicts-restore-ui.test.js) rather than a hand-rolled db
 * stub, so the COUNT/DELETE SQL is exercised for real.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import section from "../servers/gateway/dashboard/settings/sections/help-setup.js";
import { STARTER_SOURCE } from "../servers/gateway/dashboard/panels/onboarding/starter-content.js";

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "help-setup-starter-"));
  dirs.push(dir);
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  return createClient({ url: "file:" + join(dir, "crow.db") });
}

async function seedStarterRow(db, content) {
  await db.execute({
    sql: "INSERT INTO memories (content, category, source, importance) VALUES (?, 'general', ?, 5)",
    args: [content, STARTER_SOURCE],
  });
}

function fakeReq(body = {}, query = {}) {
  return { csrfToken: "test-csrf", query, body, headers: {} };
}

const CLEAR_ACTION = 'value="help_setup_clear_starter"';

test("render: n=3 starter rows shows the count and a confirm-gated clear form", async () => {
  const db = fresh();
  await seedStarterRow(db, "one");
  await seedStarterRow(db, "two");
  await seedStarterRow(db, "three");

  const html = await section.render({ req: fakeReq(), db, lang: "en" });

  assert.ok(html.includes(CLEAR_ACTION), "clear form action present");
  assert.ok(html.includes('method="POST"'), "form posts");
  assert.match(html, /name="_csrf"/, "CSRF token included");
  assert.match(html, /onsubmit="return confirm\(/, "confirm-gated submit");
  assert.match(html, /\b3\b/, "renders the current starter count");
});

test("render: n=0 starter rows shows the 'none' copy and no clear form", async () => {
  const db = fresh();

  const html = await section.render({ req: fakeReq(), db, lang: "en" });

  assert.ok(!html.includes(CLEAR_ACTION), "no clear form when there is nothing to clear");
});

test("handleAction: help_setup_clear_starter deletes source='starter' rows only and returns true", async () => {
  const db = fresh();
  await seedStarterRow(db, "one");
  await seedStarterRow(db, "two");
  await db.execute({
    sql: "INSERT INTO memories (content, category, source, importance) VALUES ('kept', 'general', 'user', 5)",
    args: [],
  });

  let redirectedTo = null;
  const res = { redirectAfterPost(url) { redirectedTo = url; } };

  const handled = await section.handleAction({
    req: fakeReq({ action: "help_setup_clear_starter" }),
    res,
    db,
    action: "help_setup_clear_starter",
  });

  assert.equal(handled, true, "action handled");
  assert.ok(redirectedTo, "redirected back to the section");
  assert.match(redirectedTo, /section=help-setup/);

  const { rows: starterRows } = await db.execute({
    sql: "SELECT COUNT(*) n FROM memories WHERE source = ?",
    args: [STARTER_SOURCE],
  });
  assert.equal(Number(starterRows[0].n), 0, "all starter rows deleted");

  const { rows: keptRows } = await db.execute({
    sql: "SELECT COUNT(*) n FROM memories WHERE source = 'user'",
    args: [],
  });
  assert.equal(Number(keptRows[0].n), 1, "non-starter memory untouched");
});

test("handleAction: non-matching action returns false and does not delete anything", async () => {
  const db = fresh();
  await seedStarterRow(db, "one");

  const res = { redirectAfterPost() { throw new Error("must not redirect"); } };
  const handled = await section.handleAction({
    req: fakeReq({ action: "some_other_action" }),
    res,
    db,
    action: "some_other_action",
  });

  assert.equal(handled, false, "unrelated action not handled");

  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) n FROM memories WHERE source = ?",
    args: [STARTER_SOURCE],
  });
  assert.equal(Number(rows[0].n), 1, "starter row untouched");
});

test("render: after clearing, the section shows the 'cleared' flash and 'none' copy", async () => {
  const db = fresh();
  await seedStarterRow(db, "one");
  await section.handleAction({
    req: fakeReq({ action: "help_setup_clear_starter" }),
    res: { redirectAfterPost() {} },
    db,
    action: "help_setup_clear_starter",
  });

  const html = await section.render({
    req: fakeReq({}, { helpSetupMsg: "cleared" }),
    db,
    lang: "en",
  });
  assert.ok(html.includes("Starter memories cleared"), "flash text present");
  assert.ok(!html.includes(CLEAR_ACTION), "no clear form once starter memories are gone");
});
