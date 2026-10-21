// scripts/ops/isolation-audit.mjs: unit inspection runs through a fake
// systemctl, so no host unit is ever read here.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditUnits, defaultSensitivePaths, auditInstanceFiles } from "../scripts/ops/isolation-audit.mjs";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "crow-audit-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("auditUnits reports only Crow units, with secret-like env NAMES and loose env-file modes", () => {
  const envFile = join(scratch, "loose.env");
  writeFileSync(envFile, "X=1\n", { mode: 0o644 });
  const tight = join(scratch, "tight.env");
  writeFileSync(tight, "X=1\n", { mode: 0o600 });
  const fake = (args) => {
    if (args[0] === "list-units") return "crow-a.service loaded active running A\nother.service loaded active running B\n";
    if (args[0] === "show" && args.includes("--value")) return args[1] === "crow-a.service" ? "PORT=1 SOME_API_TOKEN=v CROW_PEER_TOKENS_PATH=/p" : "OTHER_TOKEN=v";
    if (args[0] === "show" && args[1] === "crow-a.service") {
      return `ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node servers/gateway/index.js ; }\nWorkingDirectory=/srv/app\nFragmentPath=\nDropInPaths=\nEnvironmentFiles=${envFile} (ignore_errors=no) ${tight} (ignore_errors=no)\nUser=svc\n`;
    }
    if (args[0] === "show") return "ExecStart={ path=/usr/bin/sleep ; }\nWorkingDirectory=/\n";
    return "";
  };
  const r = auditUnits({ systemctl: fake, appRoot: "/nowhere" });
  assert.equal(r.length, 1);
  assert.equal(r[0].unit, "crow-a.service");
  assert.equal(r[0].user, "svc");
  assert.deepEqual(r[0].secretLikeEnvironment, ["SOME_API_TOKEN"]);
  const files = Object.fromEntries(r[0].environmentFiles.map((f) => [f.path, f]));
  assert.equal(files[envFile].groupOrWorld, true);
  assert.equal(files[tight].groupOrWorld, false);
  assert.ok(!JSON.stringify(r).includes("=v"), "no value appears in the report");
});

test("defaultSensitivePaths: other .crow* homes beside this one, plus key dirs; never its own home", () => {
  const home = join(scratch, "home");
  for (const d of [".crow/data", ".crow-r9/data", ".crowbar/data", "crow/data", ".crow-backups"]) mkdirSync(join(home, d), { recursive: true });
  const p = defaultSensitivePaths({ home, crowHome: join(home, ".crow-r9") });
  assert.ok(p.includes(join(home, ".crow")));
  assert.ok(!p.includes(join(home, ".crow-r9")));
  assert.ok(!p.includes(join(home, ".crowbar")) && !p.includes(join(home, "crow")));
  assert.ok(!p.includes(join(home, ".crow-backups")), "a .crow-* dir that is not an instance home is skipped");
  assert.ok(p.includes(join(home, ".ssh")) && p.includes(join(home, ".gnupg")));
});

test("auditInstanceFiles: modes of the instance's own secret files, existing ones only", () => {
  const ch = join(scratch, "inst");
  mkdirSync(join(ch, "data"), { recursive: true });
  writeFileSync(join(ch, "data", "identity.json"), "{}", { mode: 0o644 });
  writeFileSync(join(ch, "board-token"), "t", { mode: 0o600 });
  const r = auditInstanceFiles({ crowHome: ch, dataDir: join(ch, "data"), appEnv: join(ch, "app.env") });
  const by = Object.fromEntries(r.map((f) => [f.path, f]));
  assert.equal(by[join(ch, "data", "identity.json")].groupOrWorld, true);
  assert.equal(by[join(ch, "board-token")].groupOrWorld, false);
  assert.equal(by[join(ch, "app.env")], undefined);
});
