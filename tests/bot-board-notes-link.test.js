/**
 * Bot-board "View note" link (Item 4-PR4 lab-value sweep, B7).
 *
 * The note link used to hardcode a lab host (http://10.0.0.39:8080/...) —
 * a dead link on every other install. Now the link renders ONLY when
 * CROW_BOT_BOARD_NOTES_URL is configured; otherwise the drawer shows plain
 * "note #<id>" text (honest absence over dead link).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientJs } from "../servers/gateway/dashboard/panels/bot-board/client.js";

test("no notes base URL configured -> no lab host, no dead link", () => {
  delete process.env.CROW_BOT_BOARD_NOTES_URL;
  const js = clientJs("botx", "kanban", 1, null, [], "en");
  assert.ok(!js.includes("10.0.0.39"), "lab host must not appear");
  // Unconfigured: note id renders as plain text, not an anchor.
  assert.match(js, /createElement\('span'\)|createElement\("span"\)/, "should render a non-link note element when unconfigured");
});

test("configured notes base URL -> link renders from config", () => {
  process.env.CROW_BOT_BOARD_NOTES_URL = "https://notes.example.com/notes/";
  try {
    const js = clientJs("botx", "kanban", 1, null, [], "en");
    assert.ok(js.includes("https://notes.example.com/notes/"), "configured base must be interpolated");
    assert.ok(!js.includes("10.0.0.39"), "lab host must not appear");
  } finally {
    delete process.env.CROW_BOT_BOARD_NOTES_URL;
  }
});
