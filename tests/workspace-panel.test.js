/** Crow Workspace "Office" setup page (W1 Task 7). Pure render functions — no gateway import. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import panel, { WORKSPACE_STRINGS, readPublicSettings, workspaceUrls, renderWorkspacePage } from "../bundles/workspace/panel/workspace.js";

function home(envText) {
  const h = mkdtempSync(join(tmpdir(), "ws-panel-"));
  if (envText !== null) {
    mkdirSync(join(h, "bundles", "workspace"), { recursive: true });
    writeFileSync(join(h, "bundles", "workspace", ".env"), envText, { mode: 0o600 });
  }
  return h;
}
const ENV = [
  "WORKSPACE_ADMIN_USER=admin", "WORKSPACE_DB_PASSWORD=db-SECRET-x", "WORKSPACE_ONLYOFFICE_JWT_SECRET=jwt-SECRET-y",
  "WORKSPACE_FIRSTRUN_ADMIN_PASSWORD=firstrun-SECRET-z", "WORKSPACE_BOT_APP_PASSWORD=TOKEN-zzz",
  "WORKSPACE_BOOTSTRAP_DONE=1", "WORKSPACE_PUBLIC_HOST=box.tailnet-example.ts.net", "WORKSPACE_NC_SERVE_PORT=8456", "WORKSPACE_OO_SERVE_PORT=8457",
].join("\n") + "\n";
const keysDeep = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keysDeep(v, `${p}${k}.`) : [`${p}${k}`])).sort();

test("en and es carry the same keys, all non-empty", () => {
  assert.deepEqual(keysDeep(WORKSPACE_STRINGS.es), keysDeep(WORKSPACE_STRINGS.en));
  for (const lang of ["en", "es"]) for (const [k, v] of Object.entries(WORKSPACE_STRINGS[lang])) assert.ok(String(v).trim(), `${lang}.${k}`);
});

test("readPublicSettings returns only the public keys (incl. the completion marker)", () => {
  assert.deepEqual(readPublicSettings(home(ENV)), {
    WORKSPACE_ADMIN_USER: "admin", WORKSPACE_BOOTSTRAP_DONE: "1", WORKSPACE_PUBLIC_HOST: "box.tailnet-example.ts.net", WORKSPACE_NC_SERVE_PORT: "8456", WORKSPACE_OO_SERVE_PORT: "8457",
  });
  assert.equal(readPublicSettings(home(null)), null);
});

test("URLs: Workspace, DAV base, editor", () => {
  const u = workspaceUrls(readPublicSettings(home(ENV)));
  assert.equal(u.nc, "https://box.tailnet-example.ts.net:8456");
  assert.equal(u.dav, "https://box.tailnet-example.ts.net:8456/remote.php/dav");
  assert.equal(u.office, "https://box.tailnet-example.ts.net:8457/");
});

test("page: address, DAVx⁵, iPhone CalDAV, tailnet note, Serve commands, backup/add-user/uninstall cleanup", () => {
  const saved = [process.env.PORT, process.env.CROW_GATEWAY_PORT]; delete process.env.PORT; delete process.env.CROW_GATEWAY_PORT;
  let html; try { html = renderWorkspacePage(readPublicSettings(home(ENV)), "en"); } finally { if (saved[0] !== undefined) process.env.PORT = saved[0]; if (saved[1] !== undefined) process.env.CROW_GATEWAY_PORT = saved[1]; }
  for (const s of ["https://box.tailnet-example.ts.net:8456", "https://box.tailnet-example.ts.net:8456/remote.php/dav", "DAVx",
    WORKSPACE_STRINGS.en.tailnetNote, "sudo tailscale serve --bg --https=8456 http://127.0.0.1:3070",
    "sudo tailscale serve --bg --https=8457 http://127.0.0.1:3071", "ops/install-backup-timer.sh --dest", "ops/add-user.sh",
    "sudo tailscale serve --bg --https=8457 --set-path=/crow-live http://127.0.0.1:3001/api/workspace/live", "live-edit plugin reach Crow", "Tailnet only; never use funnel",
    "sudo tailscale serve --https=8457 --set-path=/crow-live off",
    "sudo tailscale serve --https=8456 off", "systemctl --user disable --now crow-workspace-backup.timer"]) assert.ok(html.includes(s), s);
  assert.doesNotMatch(html, /tailscale funnel --/);
});

test("REVIEW FOCUS 5d — the page renders no secret value", () => {
  const html = renderWorkspacePage(readPublicSettings(home(ENV)), "en");
  for (const s of ["db-SECRET-x", "jwt-SECRET-y", "firstrun-SECRET-z", "TOKEN-zzz"]) assert.ok(!html.includes(s), s);
});

test("not set up / invalid values → friendly notice; values that are not shell-safe are never rendered", () => {
  for (const s of [null, { WORKSPACE_ADMIN_USER: "admin" }, { WORKSPACE_PUBLIC_HOST: "x; rm -rf ~" }, { WORKSPACE_PUBLIC_HOST: '"><script>alert(1)</script>' }]) {
    const html = renderWorkspacePage(s, "en");
    assert.ok(html.includes(WORKSPACE_STRINGS.en.notReady), JSON.stringify(s));
    assert.doesNotMatch(html, /https:\/\/:|rm -rf|<script>alert/);
  }
  const badPort = renderWorkspacePage({ WORKSPACE_BOOTSTRAP_DONE: "1", WORKSPACE_PUBLIC_HOST: "box.example", WORKSPACE_NC_SERVE_PORT: "8456; reboot" }, "en");
  assert.ok(badPort.includes("--https=8456 "), "invalid port falls back to the default");
  assert.doesNotMatch(badPort, /reboot/);
});

test("Spanish render; panel metadata (Office, files icon)", () => {
  assert.ok(renderWorkspacePage(readPublicSettings(home(ENV)), "es").includes(WORKSPACE_STRINGS.es.addressH));
  assert.equal(panel.id, "workspace");
  assert.equal(panel.name, "Office");
  assert.equal(panel.icon, "files");
  assert.equal(panel.route, "/dashboard/workspace");
  assert.equal(typeof panel.handler, "function");
});

test("uninstall text names the retained secrets (both languages); CRLF .env still reads", () => {
  for (const lang of ["en", "es"]) {
    assert.ok(WORKSPACE_STRINGS[lang].uninstallP.includes("secrets/bundle-env/workspace.env"), lang);
    assert.ok(renderWorkspacePage(readPublicSettings(home(ENV)), lang).includes("secrets/bundle-env/workspace.env"), lang);
  }
  const s = readPublicSettings(home(ENV.replace(/\n/g, "\r\n")));
  assert.equal(s.WORKSPACE_PUBLIC_HOST, "box.tailnet-example.ts.net");
  assert.equal(s.WORKSPACE_OO_SERVE_PORT, "8457");
});

test("host set but bootstrap marker missing → not ready, with the exact re-run command (real crowHome, shell-safe)", () => {
  const noMarker = ENV.replace("WORKSPACE_BOOTSTRAP_DONE=1\n", "");
  const h = home(noMarker);
  for (const lang of ["en", "es"]) {
    const html = renderWorkspacePage(readPublicSettings(h), lang, h);
    assert.ok(html.includes(WORKSPACE_STRINGS[lang].notReady), lang);
    assert.ok(html.includes(`bash ${h}/bundles/workspace/ops/bootstrap.sh`), lang);
    assert.ok(!html.includes("sudo tailscale serve"), "no setup cards before bootstrap finished");
  }
  const spaced = renderWorkspacePage(readPublicSettings(h), "en", "/home/a b/.crow");
  assert.ok(spaced.includes("bash &#39;/home/a b/.crow/bundles/workspace/ops&#39;/bootstrap.sh"), "single-quoted (HTML-escaped)");
  assert.ok(!WORKSPACE_STRINGS.en.notReady.includes("Extensions page"));
});

test("ready page prints the real crowHome in admin commands, not ~/.crow", () => {
  const h = home(ENV);
  const html = renderWorkspacePage(readPublicSettings(h), "en", h);
  assert.ok(html.includes(`bash ${h}/bundles/workspace/ops/install-backup-timer.sh --dest`));
  assert.ok(html.includes(`bash ${h}/bundles/workspace/ops/add-user.sh`));
  assert.ok(!html.includes("bash ~/.crow/bundles"));
});
