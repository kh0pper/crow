import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const DIR = "scripts/pi-bots/systemd";
const units = readdirSync(DIR).filter((f) => f.endsWith(".service") || f.endsWith(".timer"));

test("templated units exist", () => {
  for (const u of ["pibot-gateways@.service", "pibot-discord@.service", "pibot-bridge@.service", "pibot-bridge@.timer"]) {
    assert.ok(units.includes(u), `missing ${u}`);
  }
});

test("service units are instance-portable (no hardcoded ~/.crow-mpa, use EnvironmentFile, no crow-mpa-gateway dep)", () => {
  for (const u of units.filter((f) => f.endsWith(".service"))) {
    const s = readFileSync(`${DIR}/${u}`, "utf8");
    assert.ok(!/\.crow-mpa/.test(s), `${u} hardcodes ~/.crow-mpa`);
    assert.ok(/EnvironmentFile=\/etc\/crow\/pibot-%i\.env/.test(s), `${u} missing per-instance EnvironmentFile`);
    assert.ok(!/After=.*crow-mpa-gateway/.test(s), `${u} still depends on crow-mpa-gateway`);
    // node must resolve via the per-host EnvironmentFile PATH (portable across
    // hosts whose node lives at different paths/versions), NOT a hardcoded nvm path.
    assert.ok(/ExecStart=\/usr\/bin\/env node /.test(s), `${u} ExecStart should use /usr/bin/env node, not a hardcoded node path`);
    assert.ok(!/\.nvm\/versions\/node/.test(s), `${u} hardcodes an nvm node path (not portable)`);
  }
});

test("installer is portable + idempotent-flavored", () => {
  const sh = readFileSync("scripts/pi-bots/install-runtime.sh", "utf8");
  assert.ok(!/\.crow-mpa/.test(sh), "installer hardcodes ~/.crow-mpa");
  assert.ok(/\/etc\/crow\/pibot-/.test(sh), "installer doesn't write the per-instance env file");
  assert.ok(/systemctl/.test(sh) && /enable/.test(sh), "installer doesn't enable units");
});
