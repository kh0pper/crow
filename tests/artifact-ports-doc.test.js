// The artifact origin's ports are gateway-internal listeners, not compose
// ports, so scripts/check-port-allocation.js cannot see them. This keeps the
// registry rows and the docs that name CROW_ARTIFACT_ORIGIN_PORT values in step.
// None of them is ever published: the sidecar reaches the origin from its OWN
// network namespace (a loopback or bridge-gateway bind on the host, a container
// name inside an instance's network), which is what keeps the host's loopback
// off the tailnet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function allocationRows() {
  const rows = new Map();
  for (const line of read("docs/developers/port-allocation.md").split("\n")) {
    const m = /^\|\s*(\d{2,5})\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(line);
    if (m) rows.set(Number(m[1]), { bind: m[2].trim(), what: m[3].trim(), status: m[4].trim() });
  }
  return rows;
}

test("ports 3090-3093 are registered for the artifact origins and the public-link listener, reached only from the sidecar's own namespace", () => {
  const rows = allocationRows();
  for (const p of [3090, 3091, 3092, 3093]) {
    const r = rows.get(p);
    assert.ok(r, `port ${p} has a row`);
    assert.match(r.what, /artifact/i, `port ${p} is an artifacts row`);
  }
  // The origin is never published: the gateway binds loopback or the sidecar
  // bridge's gateway IP, and the household container's lives in its own
  // namespace (the sidecar joins that network and proxies by container name).
  for (const p of [3090, 3091]) {
    assert.match(rows.get(p).bind, /^127\.0\.0\.1 or the sidecar bridge gateway IP/, `port ${p} binds loopback or the bridge gateway`);
  }
  assert.match(rows.get(3092).bind, /^container namespace/, "port 3092 needs no host publish");
  assert.match(rows.get(3093).bind, /^127\.0\.0\.1/, "the public-link listener stays loopback");
  for (const p of [3090, 3091, 3092, 3093]) assert.doesNotMatch(rows.get(p).bind, /0\.0\.0\.0|every interface/, `port ${p} never binds everywhere`);
  assert.match(rows.get(3093).what, /public/i);
});

test("every CROW_ARTIFACT_ORIGIN_PORT value named in the docs is a registered artifact-origin port", () => {
  const rows = allocationRows();
  const docs = ["docs/architecture/artifacts.md", "docs/developers/port-allocation.md"];
  let seen = 0;
  for (const d of docs) {
    for (const m of read(d).matchAll(/CROW_ARTIFACT_ORIGIN_PORT\s*=\s*`?(\d{2,5})/g)) {
      seen++;
      const r = rows.get(Number(m[1]));
      assert.ok(r && /artifact origin/i.test(r.what), `${d}: CROW_ARTIFACT_ORIGIN_PORT=${m[1]} must be an artifact-origin row`);
    }
  }
  assert.ok(seen >= 1, "the docs name at least one CROW_ARTIFACT_ORIGIN_PORT value");
});
