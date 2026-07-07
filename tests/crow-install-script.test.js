import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "crow-install.sh");
const src = () => readFileSync(SCRIPT, "utf-8");

/** Source the installer's helper layer (CROW_INSTALL_SOURCE_ONLY=1) and run a
 *  snippet against it. detached:true puts the child in a new session with no
 *  controlling terminal, so the /dev/tty open-probe fails → HAS_TTY=false and
 *  the headless path is exercised even from an interactive terminal. */
function runWithHelpers(snippet, env = {}) {
  return spawnSync("bash", ["-c", `set -euo pipefail; CROW_INSTALL_SOURCE_ONLY=1 source "${SCRIPT}"; ${snippet}`], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
}

test("bash -n: installer parses", () => {
  execFileSync("bash", ["-n", SCRIPT]);
});

test("shellcheck passes when available (skips otherwise)", (t) => {
  const which = spawnSync("shellcheck", ["--version"], { stdio: "ignore" });
  if (which.error) return t.skip("shellcheck not installed");
  // SC2154/SC1090/SC1091: sourced-file + installer-pattern noise; everything else must pass
  const r = spawnSync("shellcheck", ["-e", "SC1090,SC1091", SCRIPT], { encoding: "utf-8" });
  assert.equal(r.status, 0, r.stdout);
});

test("F-5: headless ask_yn resolves to its default (Y and N)", () => {
  const y = runWithHelpers(`if ask_yn "Continue?" Y; then echo YES; else echo NO; fi`);
  assert.equal(y.status, 0, y.stderr);
  assert.match(y.stdout, /YES/);
  const n = runWithHelpers(`if ask_yn "Rename?" N; then echo YES; else echo NO; fi`);
  assert.equal(n.status, 0, n.stderr);
  assert.match(n.stdout, /NO/);
});

test("F-5: CROW_INSTALL_YES=1 forces defaults without a tty", () => {
  const r = runWithHelpers(`if ask_yn "Continue?" Y; then echo YES; fi; if ask_yn "Rename?" N; then echo BAD; else echo SKIPPED; fi`, { CROW_INSTALL_YES: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /YES/);
  assert.match(r.stdout, /SKIPPED/);
});

test("F-5: ask_line returns empty headlessly instead of failing under set -e", () => {
  const r = runWithHelpers(`v="$(ask_line "name: ")"; echo "got:[\${v}]"`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /got:\[\]/);
});

test("F-6: no pipeline consumes `tailscale status --json` (captured into TS_JSON instead)", () => {
  const tsLines = src().split("\n").filter((l) => l.includes("tailscale status --json"));
  assert.ok(tsLines.length > 0, "TS_JSON capture exists");
  for (const l of tsLines) {
    assert.doesNotMatch(l.replaceAll("||", ""), /\|/, `pipeline on: ${l.trim()}`);
  }
  assert.match(src(), /TS_JSON=/);
});

test("F-6: no `| head` pipelines remain in the installer", () => {
  assert.doesNotMatch(src(), /\|\s*head\b/);
});

test("F-6: ufw enable is --force, not echo-piped", () => {
  assert.doesNotMatch(src(), /echo[^\n]*\|\s*sudo ufw enable/);
  assert.match(src(), /sudo ufw --force enable/);
});

test("F-7: tailscale rename prompt defaults N (never renames headlessly)", () => {
  assert.match(src(), /ask_yn "Set Tailscale hostname to 'crow'\?" N/);
});

test("F-6/F-7: helper extraction — first HostName in TS_JSON via bash regex, no pipes", () => {
  const obj = { Self: { HostName: "black-swan", DNSName: "black-swan.tn.ts.net." }, Peer: { k: { HostName: "crow", DNSName: "crow.tn.ts.net." } } };
  // Real `tailscale status --json` output is INDENTED (Go marshaler): `"HostName": "crow"`
  // with a space after the colon. Fixture must match that shape or it masks regressions.
  const indented = JSON.stringify(obj, null, 2);
  // TS_JSON passed via env (visible to the sourced helpers) — sidesteps shell quoting of multi-line JSON.
  const r = runWithHelpers(`ts_first_field HostName; echo; ts_first_field DNSName`, { TS_JSON: indented });
  assert.equal(r.status, 0, r.stderr);
  const [host, dns] = r.stdout.trim().split("\n");
  assert.equal(host, "black-swan");
  assert.equal(dns, "black-swan.tn.ts.net.");
  // Compact JSON (no space after colon) must also work.
  const compact = runWithHelpers(`ts_first_field HostName`, { TS_JSON: JSON.stringify(obj) });
  assert.equal(compact.status, 0, compact.stderr);
  assert.equal(compact.stdout.trim(), "black-swan");
});

test("F-6/F-7: collision check matches indented `\"HostName\": \"crow\"` (real tailscale JSON shape)", () => {
  const check = `if [[ $TS_JSON =~ \\"HostName\\"[[:space:]]*:[[:space:]]*\\"crow\\" ]]; then echo HIT; else echo MISS; fi`;
  const withCrow = JSON.stringify({ Self: { HostName: "black-swan" }, Peer: { k: { HostName: "crow" } } }, null, 2);
  const hit = runWithHelpers(check, { TS_JSON: withCrow });
  assert.equal(hit.status, 0, hit.stderr);
  assert.equal(hit.stdout.trim(), "HIT");
  const withoutCrow = JSON.stringify({ Self: { HostName: "black-swan" }, Peer: { k: { HostName: "crow-2" } } }, null, 2);
  const miss = runWithHelpers(check, { TS_JSON: withoutCrow });
  assert.equal(miss.status, 0, miss.stderr);
  assert.equal(miss.stdout.trim(), "MISS");
});

test("F-1: Serve wiring present — serve command + CROW_GATEWAY_URL write + gateway restart", () => {
  assert.match(src(), /tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:3001/);
  assert.match(src(), /CROW_GATEWAY_URL=\$\{GATEWAY_HTTPS_URL\}|CROW_GATEWAY_URL=%s/);
  assert.match(src(), /systemctl restart crow-gateway/);
});

test("F-2: 443 is prompted, with cloud-metadata heuristic flipping the default", () => {
  assert.match(src(), /169\.254\.169\.254/);
  assert.match(src(), /OPEN_443_DEFAULT/);
  // The bare unconditional allow must be gone:
  assert.doesNotMatch(src(), /^sudo ufw allow 443\/tcp/m);
});

test("F-5 end-state pin (deferred from A1): no raw read -p prompts remain anywhere", () => {
  assert.doesNotMatch(src(), /read -p/);
});

test("collision elif stays whitespace-tolerant (pin for the A2 HIT/MISS test's regex copy)", () => {
  assert.match(src(), /elif \[\[ \$TS_JSON =~ \\"HostName\\"\[\[:space:\]\]\*:\[\[:space:\]\]\*\\"crow\\" \]\]/);
});

test("F-9: systemd unit uses Restart=on-failure (unless-stopped is Docker, not systemd)", () => {
  assert.match(src(), /Restart=on-failure/);
  assert.doesNotMatch(src(), /Restart=unless-stopped/);
});

test("R2-I1: unit ordering matches prod (gateway runs docker compose and keys residency on the tailscale IP)", () => {
  assert.match(src(), /After=network-online\.target docker\.service tailscaled\.service/);
  assert.match(src(), /Wants=network-online\.target/);
  assert.match(src(), /Requires=docker\.service/);
});

test("F-11: OS hostname rename prompt defaults N", () => {
  assert.match(src(), /ask_yn "Set hostname to 'crow' \(enables crow\.local\)\?" N/);
});

test("F-11: Caddy vhost and final URL follow the ACTUAL hostname (MDNS_HOST)", () => {
  assert.match(src(), /MDNS_HOST="\$\(hostname\)\.local"/);
  assert.match(src(), /\$\{MDNS_HOST\} \{/);          // Caddyfile vhost
  assert.match(src(), /https:\/\/\$\{MDNS_HOST\}\/setup/); // final message
});
