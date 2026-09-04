// tests/box-reservation-notify.test.js
//
// Visibility rule (scope §3.5): once per reservation the operator hears that
// the box is reserved, and once per reservation that a model start was
// refused. The decision is a pure state machine so it needs no DB; the sender
// is a thin wrapper that must never throw into the orchestrator.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createNoticeState, reservationNotices, sendReservationNotice,
} from "../servers/gateway/box-reservation-notify.js";

const R1 = { owner: "win", reason: "bench", started_at: "2026-09-04T20:00:00.000Z", expires_at: "2026-09-04T23:00:00.000Z", allow: ["crow-embed"], corrupt: false, key: "win@2026-09-04T20:00:00.000Z" };
const R2 = { ...R1, owner: "kevin", started_at: "2026-09-04T23:30:00.000Z", key: "kevin@2026-09-04T23:30:00.000Z" };

test("first sight of a reservation emits 'start' once; later sights emit nothing", () => {
  const st = createNoticeState();
  assert.deepEqual(reservationNotices(st, { reservation: R1 }), [{ kind: "start", reservation: R1 }]);
  assert.deepEqual(reservationNotices(st, { reservation: R1 }), []);
  assert.deepEqual(reservationNotices(st, { reservation: R1 }), []);
});

test("no reservation emits nothing and does not disturb state", () => {
  const st = createNoticeState();
  assert.deepEqual(reservationNotices(st, { reservation: null }), []);
  assert.deepEqual(reservationNotices(st, { reservation: R1 }), [{ kind: "start", reservation: R1 }]);
});

test("a refusal emits 'refused' once per reservation (and 'start' first if unseen)", () => {
  const st = createNoticeState();
  const first = reservationNotices(st, { reservation: R1, refused: { provider: "crow-chat", requester: "10.0.0.5 ua=x client=companion" } });
  assert.deepEqual(first.map((n) => n.kind), ["start", "refused"]);
  assert.equal(first[1].refused.provider, "crow-chat");
  assert.deepEqual(reservationNotices(st, { reservation: R1, refused: { provider: "crow-chat", requester: "-" } }), []);
  assert.deepEqual(reservationNotices(st, { reservation: R1, refused: { provider: "crow-voice", requester: "-" } }), [], "once per reservation, not per provider");
});

test("a new reservation key resets both notices; old keys are forgotten (bounded state)", () => {
  const st = createNoticeState();
  reservationNotices(st, { reservation: R1, refused: { provider: "crow-chat", requester: "-" } });
  const n = reservationNotices(st, { reservation: R2, refused: { provider: "crow-chat", requester: "-" } });
  assert.deepEqual(n.map((x) => x.kind), ["start", "refused"]);
  assert.equal(st.seen.size, 1, "only the live key is retained");
});

test("corrupt reservation: 'start' notice names the unreadable file, refused still once", () => {
  const st = createNoticeState();
  const corrupt = { owner: "unknown", reason: "unreadable reservation file", started_at: null, expires_at: null, allow: [], corrupt: true, key: "corrupt" };
  const n = reservationNotices(st, { reservation: corrupt, refused: { provider: "crow-chat", requester: "-" } });
  assert.deepEqual(n.map((x) => x.kind), ["start", "refused"]);
  assert.deepEqual(reservationNotices(st, { reservation: corrupt, refused: { provider: "crow-chat", requester: "-" } }), []);
});

test("sendReservationNotice: shapes the notification and swallows sender failures", async () => {
  const calls = [];
  const ok = await sendReservationNotice({ kind: "start", reservation: R1 }, { notify: async (opts) => { calls.push(opts); } });
  assert.equal(ok, true);
  assert.equal(calls[0].type, "system");
  assert.equal(calls[0].priority, "normal");
  assert.match(calls[0].title, /Box reserved by win until 2026-09-04T23:00:00\.000Z/);
  assert.match(calls[0].body, /bench/);
  assert.equal(calls[0].action_url, "/dashboard/models");

  const r = await sendReservationNotice({ kind: "refused", reservation: R1, refused: { provider: "crow-chat", requester: "10.0.0.5 ua=x client=companion" } }, { notify: async (opts) => { calls.push(opts); } });
  assert.equal(r, true);
  assert.equal(calls[1].priority, "high");
  assert.match(calls[1].title, /refused a model start: crow-chat/);
  assert.match(calls[1].body, /companion/);

  const bad = await sendReservationNotice({ kind: "start", reservation: R1 }, { notify: async () => { throw new Error("db down"); } });
  assert.equal(bad, false, "never throws into the orchestrator");
});
