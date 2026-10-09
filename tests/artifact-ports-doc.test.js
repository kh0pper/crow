// The artifact origin's ports are gateway-internal listeners, not compose
// ports, so scripts/check-port-allocation.js cannot see them. This keeps the
// registry rows and the docs that name CROW_ARTIFACT_ORIGIN_PORT values in step.
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

test("ports 3090-3093 are registered for the artifact origins and the public-link listener, loopback only", () => {
  const rows = allocationRows();
  for (const p of [3090, 3091, 3092, 3093]) {
    const r = rows.get(p);
    assert.ok(r, `port ${p} has a row`);
    assert.match(r.bind, /^127\.0\.0\.1/, `port ${p} binds loopback`);
    assert.match(r.what, /artifact/i, `port ${p} is an artifacts row`);
  }
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
