// Queue item 19, step 2c: the `egress` permission key (contained bots).
import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePermissionPolicy, peerPolicyWidening, POLICY_KEYS } from "../servers/shared/bot-permission-policy.js";

test("egress is a stored policy key with a host-name shape", () => {
  assert.ok(POLICY_KEYS.includes("egress"));
  assert.deepEqual(validatePermissionPolicy({ egress: ["api.github.com", "*.googleapis.com"] }), []);
  for (const bad of [["http://x.com"], ["x.com/path"], ["*"], [""], ["a..b"], "x.com", [1]]) {
    assert.ok(validatePermissionPolicy({ egress: bad }).length, JSON.stringify(bad));
  }
  assert.ok(validatePermissionPolicy({ egress: Array.from({ length: 101 }, (_, i) => `h${i}.example.com`) }).length);
});

test("a peer may only narrow egress: adding a host or dropping the list widens", () => {
  assert.equal(peerPolicyWidening({}, { egress: ["a.example.com"] }), null, "absent → list narrows");
  assert.equal(peerPolicyWidening({ egress: ["a.example.com", "b.example.com"] }, { egress: ["a.example.com"] }), null);
  assert.equal(peerPolicyWidening({ egress: ["a.example.com"] }, { egress: ["a.example.com", "c.example.com"] }), "egress");
  assert.equal(peerPolicyWidening({ egress: ["a.example.com"] }, {}), "egress", "dropping the list = any host");
  assert.equal(peerPolicyWidening({ egress: ["A.example.com"] }, { egress: ["a.example.com"] }), null, "case-insensitive");
});
