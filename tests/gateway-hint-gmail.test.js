// Chat-channel gateway hints must forbid REPLYING via gmail (the reply is
// delivered on the channel) without forbidding gmail tools outright: an
// email-assistant bot reached over Perch/Discord needs them to do its job.
// The old blanket "Do NOT use gmail tools." made such a bot refuse every
// email task (Dayane's Bobby, 2026-09-29).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatewayHint } from "../scripts/pi-bots/gateways/index.mjs";

for (const type of ["discord", "perch", "telegram", "slack", "crow-messages"]) {
  test(`${type} hint forbids replying via gmail, not using gmail tools`, () => {
    const h = gatewayHint(type, "T1");
    assert.ok(!h.includes("Do NOT use gmail tools"), h);
    assert.ok(h.includes("Do NOT reply via gmail tools"), h);
  });
}

test("gmail hint is unchanged: reply by drafting into the thread", () => {
  assert.match(gatewayHint("gmail", "T1"), /pass this verbatim as thread_id when drafting your reply via gmail_create_draft/);
});
