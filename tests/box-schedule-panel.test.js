/**
 * Model Catalog — the Box schedule section (the one box calendar, the
 * private engineering notes §6.3).
 *
 * Pure-render tests: every fixture is a plain schedule object, so nothing
 * here reads a real calendar or the real hold file. The last test guards the
 * one hard rule the panel's client code lives under — the <script> is built
 * inside a template literal, so it must never contain a backtick.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderBoxScheduleSection, boxScheduleClientJS,
} from "../servers/gateway/dashboard/panels/model-catalog-box-schedule.js";

const HOUR = 60 * 60 * 1000;

function booking(overrides = {}) {
  const start = Date.now() + HOUR;
  return {
    id: "bk_aaaaaaaaaaaa",
    owner: "alex",
    kind: "window",
    mode: "exclusive",
    start: new Date(start).toISOString(),
    end: new Date(start + HOUR).toISOString(),
    reason: "window run",
    allow: [],
    evict: [],
    approval: { state: "not_needed" },
    status: "booked",
    created_by: "cli",
    ...overrides,
  };
}

/** The rendered <tr> for one booking id, so assertions stay row-scoped. */
function rowFor(html, id) {
  const start = html.indexOf(`data-box-row="${id}"`);
  assert.ok(start > -1, `no row rendered for ${id}`);
  return html.slice(start, html.indexOf("</tr>", start));
}

test("renders the active hold and the next bookings", () => {
  const start = Date.now() + HOUR;
  const html = renderBoxScheduleSection({
    active: {
      owner: "alex",
      kind: "window",
      mode: "exclusive",
      started_at: new Date(Date.now() - HOUR).toISOString(),
      expires_at: new Date(Date.now() + 2 * HOUR).toISOString(),
    },
    bookings: [booking({ id: "bk_active_row", start: new Date(start).toISOString() })],
  }, "en");

  assert.match(html, /Box schedule/);
  assert.match(html, /Held by alex/);
  assert.match(html, /Model window/);
  assert.match(html, /Exclusive/);
  const row = rowFor(html, "bk_active_row");
  assert.match(row, /alex/);
  assert.match(row, /Booked/);
  assert.match(row, /window run/);
});

test("pending row has Approve and Decline, booked row has Cancel", () => {
  const pending = booking({
    id: "bk_pending0001",
    reason: "wants to evict",
    evict: ["crow-chat"],
    approval: { state: "pending" },
  });
  const plain = booking({ id: "bk_plain000001", owner: "nightly-audit", kind: "audit" });
  const html = renderBoxScheduleSection({ active: null, bookings: [pending, plain] }, "en");

  const pendingRow = rowFor(html, "bk_pending0001");
  assert.match(pendingRow, /data-box-action="approve" data-box-id="bk_pending0001"/);
  assert.match(pendingRow, /data-box-action="decline" data-box-id="bk_pending0001"/);
  assert.doesNotMatch(pendingRow, /data-box-action="cancel"/);
  assert.match(pendingRow, /Pending approval/);

  const plainRow = rowFor(html, "bk_plain000001");
  assert.match(plainRow, /data-box-action="cancel" data-box-id="bk_plain000001"/);
  assert.doesNotMatch(plainRow, /data-box-action="approve"/);
  assert.doesNotMatch(plainRow, /data-box-action="decline"/);
});

test("empty state when the box is free", () => {
  const html = renderBoxScheduleSection({ active: null, bookings: [] }, "en");
  assert.match(html, /The box is free\./);
  assert.match(html, /Nothing is booked in the next 48 hours\./);
  assert.doesNotMatch(html, /data-box-action="approve"/);

  const es = renderBoxScheduleSection({ active: null, bookings: [] }, "es");
  assert.match(es, /El equipo está libre\./);
});

test("escapes owner and reason strings", () => {
  const owner = '<img src=x onerror="alert(1)">';
  const reason = '<script>alert("x")</script> & more';
  const html = renderBoxScheduleSection({
    active: { owner, kind: "manual", mode: "exclusive", expires_at: new Date(Date.now() + HOUR).toISOString() },
    bookings: [booking({ id: "bk_escape00001", owner, reason })],
  }, "en");

  assert.ok(!html.includes(owner), "the raw owner string is never emitted");
  assert.ok(!html.includes(reason), "the raw reason string is never emitted");
  assert.ok(!html.includes("<img src=x"), "no injected element from the owner");
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.ok(!html.includes("<script>alert"), "no injected script from the reason");
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; more/);
});

test("client JS contains no backtick", () => {
  const out = boxScheduleClientJS("en");
  const script = out.slice(out.indexOf("<script>"), out.lastIndexOf("</script>"));
  assert.ok(script.length > 200);
  assert.equal(script.includes("`"), false, "a literal backtick would break the whole dashboard");
  assert.match(out, /X-Crow-Csrf/);
  assert.match(out, /\/api\/box/);
  assert.doesNotMatch(out, /\.innerHTML\s*=/);
  // The Spanish copy is emitted into the same script without breaking it.
  assert.equal(boxScheduleClientJS("es").includes("`"), false);
});