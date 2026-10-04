import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let R, C;
const PW = "p@ss/w0rd+=x";
before(async () => {
  const home = mkdtempSync(join(tmpdir(), "ws-redact-"));
  mkdirSync(join(home, "bundles", "workspace"), { recursive: true });
  writeFileSync(join(home, "bundles", "workspace", ".env"), `WORKSPACE_BOOTSTRAP_DONE=1\nWORKSPACE_PUBLIC_HOST=crow.test\nWORKSPACE_BOT_APP_PASSWORD='${PW}'\nWORKSPACE_ONLYOFFICE_JWT_SECRET=sekrit-jwt\n`, { mode: 0o600 });
  process.env.CROW_HOME = home;
  R = await import("../bundles/workspace/server/result.js");
  C = await import("../bundles/workspace/server/config.js");
});

const forms = () => [PW, encodeURIComponent(PW), Buffer.from(`crow-bot:${PW}`).toString("base64"), Buffer.from(`crow-bot:${PW}`).toString("base64url"), "sekrit-jwt"];

test("redact covers plain, encodeURIComponent and Basic base64 forms of every secret", () => {
  const cfg = C.getConfig();
  const out = C.redact(`a ${forms().join(" b ")} c`, cfg);
  for (const f of forms()) assert.ok(!out.includes(f), `leaked ${f}`);
  assert.match(out, /\[redacted\]/);
});

test("handler redacts WsError message and data, deeply", async () => {
  const h = R.handler(async () => { throw new R.WsError("workspace_error", `upstream said ${forms()[2]}`, { body: `x ${forms()[1]}`, nested: [{ v: PW }, 3] }); });
  const r = await h({});
  const s = r.content[0].text;
  for (const f of forms()) assert.ok(!s.includes(f), `leaked ${f}`);
  const j = JSON.parse(s);
  assert.equal(j.code, "workspace_error"); assert.equal(j.data.nested[1], 3); assert.match(j.data.nested[0].v, /\[redacted\]/);
});
