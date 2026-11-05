import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  const obj = { Self: { HostName: "vps-1", DNSName: "vps-1.tn.ts.net." }, Peer: { k: { HostName: "crow", DNSName: "crow.tn.ts.net." } } };
  // Real `tailscale status --json` output is INDENTED (Go marshaler): `"HostName": "crow"`
  // with a space after the colon. Fixture must match that shape or it masks regressions.
  const indented = JSON.stringify(obj, null, 2);
  // TS_JSON passed via env (visible to the sourced helpers) — sidesteps shell quoting of multi-line JSON.
  const r = runWithHelpers(`ts_first_field HostName; echo; ts_first_field DNSName`, { TS_JSON: indented });
  assert.equal(r.status, 0, r.stderr);
  const [host, dns] = r.stdout.trim().split("\n");
  assert.equal(host, "vps-1");
  assert.equal(dns, "vps-1.tn.ts.net.");
  // Compact JSON (no space after colon) must also work.
  const compact = runWithHelpers(`ts_first_field HostName`, { TS_JSON: JSON.stringify(obj) });
  assert.equal(compact.status, 0, compact.stderr);
  assert.equal(compact.stdout.trim(), "vps-1");
});

test("F-6/F-7: collision check matches indented `\"HostName\": \"crow\"` (real tailscale JSON shape)", () => {
  const check = `if [[ $TS_JSON =~ \\"HostName\\"[[:space:]]*:[[:space:]]*\\"crow\\" ]]; then echo HIT; else echo MISS; fi`;
  const withCrow = JSON.stringify({ Self: { HostName: "vps-1" }, Peer: { k: { HostName: "crow" } } }, null, 2);
  const hit = runWithHelpers(check, { TS_JSON: withCrow });
  assert.equal(hit.status, 0, hit.stderr);
  assert.equal(hit.stdout.trim(), "HIT");
  const withoutCrow = JSON.stringify({ Self: { HostName: "vps-1" }, Peer: { k: { HostName: "crow-2" } } }, null, 2);
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

// ─── Item 4-PR5: platform gate + Tailscale offer ───

/** Write an os-release fixture and return its path. */
function osReleaseFixture(contents) {
  const dir = mkdtempSync(join(tmpdir(), "crow-osrel-"));
  const p = join(dir, "os-release");
  writeFileSync(p, contents);
  return p;
}

test("4c: check_platform accepts Debian/Ubuntu and their derivatives (os-release path seam)", () => {
  const fixtures = [
    "ID=ubuntu\nID_LIKE=debian\n",
    "ID=debian\n",
    "ID=raspbian\nID_LIKE=debian\n",
    'ID="linuxmint"\nID_LIKE="ubuntu debian"\n', // quoted values, multi-word ID_LIKE
  ];
  for (const fx of fixtures) {
    // Distinct tokens (not SUPPORTED/UNSUPPORTED — /SUPPORTED/ matches inside
    // "UNSUPPORTED", which made the RED phase of this test pass vacuously).
    const r = runWithHelpers(`if check_platform "${osReleaseFixture(fx)}"; then echo PLAT_OK; else echo PLAT_NO; fi`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PLAT_OK/, `fixture should be supported:\n${fx}\ngot: ${r.stdout} ${r.stderr}`);
  }
});

test("4c MUTATION (platform gate): check_platform REJECTS non-Debian os-release, a missing file, and a missing apt-get", () => {
  // Deleting or inverting the gate's ID/ID_LIKE match or its apt probe turns
  // at least one of these three UNSUPPORTED assertions red.
  const fedora = runWithHelpers(`if check_platform "${osReleaseFixture("ID=fedora\n")}"; then echo PLAT_OK; else echo PLAT_NO; fi`);
  assert.equal(fedora.status, 0, fedora.stderr);
  assert.match(fedora.stdout, /PLAT_NO/, "fedora must be rejected");

  const missing = runWithHelpers(`if check_platform "/definitely/not/os-release"; then echo PLAT_OK; else echo PLAT_NO; fi`);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /PLAT_NO/, "missing os-release must be rejected");

  // apt-probe seam: same debian fixture, but the apt command name can't resolve.
  const noApt = runWithHelpers(`if check_platform "${osReleaseFixture("ID=debian\n")}" definitely-not-a-command; then echo PLAT_OK; else echo PLAT_NO; fi`);
  assert.equal(noApt.status, 0, noApt.stderr);
  assert.match(noApt.stdout, /PLAT_NO/, "absent apt-get must be rejected even on a debian ID");
});

test("4c: platform gate is defined above the source-only seam and CALLED below it, before Step 1 / any system mutation", () => {
  const s = src();
  const seamIdx = s.indexOf('CROW_INSTALL_SOURCE_ONLY');
  const defIdx = s.indexOf("check_platform()");
  const callMatch = s.match(/^if ! check_platform(;| )/m);
  assert.ok(defIdx !== -1, "check_platform() must be defined");
  assert.ok(callMatch, "the install body must gate on `if ! check_platform`");
  assert.ok(defIdx < seamIdx, "definition must sit ABOVE the seam so tests can source it");
  const callIdx = s.indexOf(callMatch[0]);
  assert.ok(callIdx > seamIdx, "the call must sit BELOW the seam (in the install body)");
  assert.ok(callIdx < s.indexOf("Step 1/9"), "the gate must run before Step 1 (first apt mutation)");
  // The refusal must name the docs manual path and exit 1, not half-install.
  const refusal = s.slice(callIdx, s.indexOf("fi", callIdx));
  assert.match(refusal, /docs\/getting-started/, "refusal must point at the manual path");
  assert.match(refusal, /exit 1/);
});

test("4c: Tailscale-not-installed branch offers the official installer (default Y), keeping the tip when declined", () => {
  const s = src();
  assert.match(s, /ask_yn "Install Tailscale now \(recommended for secure remote access\)\?" Y/);
  // Official installer, sudo semantics consistent with get.docker.com (`| sudo sh`).
  assert.match(s, /curl -fsSL https:\/\/tailscale\.com\/install\.sh \| sudo sh/);
  // The offer lives inside the not-installed else branch.
  const afterWarn = s.split('warn "Tailscale is not installed"')[1] || "";
  assert.match(afterWarn.slice(0, 1200), /ask_yn "Install Tailscale now/);
  // Post-install guidance: authenticate, then re-run.
  assert.match(afterWarn.slice(0, 1200), /tailscale up/);
  // Declining keeps the existing tip.
  assert.match(afterWarn, /tailscale-setup\.md/);
});

test("4c MUTATION (tailscale offer default): headless resolution of the exact offer prompt is YES", () => {
  // Flipping the offer's default to N (or breaking ask_yn's default handling)
  // turns this red: a headless appliance install must still get Tailscale
  // (inert until `tailscale up`, per the design spec §2.5).
  const r = runWithHelpers(`if ask_yn "Install Tailscale now (recommended for secure remote access)?" Y; then echo INSTALL; else echo SKIP; fi`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /INSTALL/);
});

test("4c: header install list mentions Tailscale (offered) and the Debian/Ubuntu platform requirement", () => {
  const s = src();
  const header = s.slice(s.indexOf("This script will install:"), s.indexOf("Continue?"));
  assert.match(header, /Tailscale/);
  assert.match(header, /offered/i);
  assert.match(s.slice(0, s.indexOf("set -euo pipefail")), /Debian\/Ubuntu/, "header comment states the platform requirement");
});

test("F-11: Caddy vhost and final URL follow the ACTUAL hostname (MDNS_HOST)", () => {
  assert.match(src(), /MDNS_HOST="\$\(hostname\)\.local"/);
  assert.match(src(), /\$\{MDNS_HOST\} \{/);          // Caddyfile vhost
  assert.match(src(), /https:\/\/\$\{MDNS_HOST\}\/setup/); // final message
});

// ─── C1/C3 Task 10: closing-output rewrite, Docker-warn move, cloud fallback ───

test("Task 10: closing block no longer contains the old 'What's next' / 'Useful commands' tail", () => {
  const s = src();
  assert.doesNotMatch(s, /What's next/);
  assert.doesNotMatch(s, /Useful commands/);
  assert.doesNotMatch(s, /npm run local-token/, "the headless local-token step must be gone from the installer tail");
  assert.doesNotMatch(s, /API keys go in/);
  assert.doesNotMatch(s, /crow bundle install <x>/);
  assert.doesNotMatch(s, /Tip: run 'crow status'/);
});

test("Task 10: closing block is exactly 'Crow is ready!' + dashboard URL + one 'everything else happens there' pointer", () => {
  const s = src();
  const closing = s.slice(s.indexOf('header "Installation Complete"'));
  assert.match(closing, /echo "  Crow is ready!"/);
  assert.match(closing, /echo "  Everything else happens there — the setup wizard walks you through"/);
  assert.match(closing, /echo "  passwords, your AI model, and connecting devices\."/);
});

test("Task 10: cloud fallback prints an SSH tunnel to :3001 instead of the mDNS URL when IS_CLOUD_HOST and no GATEWAY_HTTPS_URL", () => {
  const s = src();
  const closing = s.slice(s.indexOf('header "Installation Complete"'));
  assert.match(closing, /if \[ "\$IS_CLOUD_HOST" = true \] && \[ -z "\$\{GATEWAY_HTTPS_URL:-\}" \]; then/, "must branch on the EXISTING IS_CLOUD_HOST var, no new flag");
  assert.match(closing, /This is a cloud server: \$\{MDNS_HOST\} is not reachable from your browser\./);
  assert.match(closing, /ssh -L 3001:localhost:3001 \$\{USER\}@<this-server's-public-IP>/);
  assert.match(closing, /Or re-run this installer and accept Tailscale Serve for a permanent URL\./);
  // The mDNS "Open in your browser" line must live in the else branch, not print unconditionally.
  const ifIdx = closing.indexOf('if [ "$IS_CLOUD_HOST" = true ]');
  const elseIdx = closing.indexOf("else", ifIdx);
  const fiIdx = closing.indexOf("fi", elseIdx);
  assert.ok(ifIdx !== -1 && elseIdx !== -1 && fiIdx !== -1, "if/else/fi must all be present");
  assert.match(closing.slice(elseIdx, fiIdx), /Open in your browser:/);
  assert.match(closing.slice(elseIdx, fiIdx), /https:\/\/\$\{MDNS_HOST\}\/setup/);
});

test("Task 10 MUTATION: only ONE IS_CLOUD_HOST is declared (the metadata-probe one) — the closing block must reuse it, not redeclare", () => {
  const matches = src().match(/^IS_CLOUD_HOST=/gm) || [];
  assert.equal(matches.length, 1, "IS_CLOUD_HOST must be set exactly once (at the cloud-metadata check)");
});

test("Task 10: Docker step no longer warns about re-login — the extensions banner is the point-of-use now", () => {
  const s = src();
  const dockerStep = s.slice(s.indexOf('header "Step 3/9: Docker"'), s.indexOf('header "Step 4/9: Caddy"'));
  assert.doesNotMatch(dockerStep, /log out and back in/i);
  assert.match(dockerStep, /log "Docker installed"/, "the install-success log line must remain");
});

test("libatomic1 is installed in the Node step, before any npm install/ci (rocksdb-native's prebuild needs libatomic.so.1)", () => {
  const s = src();
  // Unindented: it must sit after the Node if/else branch, so the
  // "already installed" path runs it too.
  const aptIdx = s.search(/^sudo apt install -y libatomic1$/m);
  assert.ok(aptIdx > -1, "an unconditional `sudo apt install -y libatomic1` must exist");
  // First real dependency install (comments excluded); `npm run identity` et al. do not count.
  const npmLine = s.split("\n").find((l) => !/^\s*#/.test(l) && /\bnpm (?:ci|install|run setup)\b/.test(l));
  assert.ok(npmLine, "the script installs dependencies somewhere");
  const npmIdx = s.indexOf(npmLine);
  assert.ok(aptIdx < npmIdx, "libatomic1 must be installed before npm runs");
  // Inside Step 2 (Node), after the branch that may skip the nodejs install.
  const step2 = s.indexOf('header "Step 2/9: Node.js');
  const step3 = s.indexOf('header "Step 3/9: Docker"');
  assert.ok(step2 < aptIdx && aptIdx < step3, "libatomic1 belongs to the Node step");
  // After the whole Node if/else, so both paths (installed / just installed) run it.
  assert.ok(aptIdx > s.indexOf("\nfi\n", step2), "must run on the Node-already-installed path too");
});

// ─── The dedicated proxy socket (the security audit's finding N1a-3/N1a-4) ───

const FIX_SCRIPT = resolve(import.meta.dirname, "..", "scripts", "fix-caddy-proxy-socket.sh");
const fixSrc = () => readFileSync(FIX_SCRIPT, "utf-8");

/** The text between the gateway unit's `tee` and the Caddyfile's. */
function gatewayUnitBlock(s) {
  return s.slice(
    s.indexOf("sudo tee /etc/systemd/system/crow-gateway.service"),
    s.indexOf("# Caddy reverse proxy"),
  );
}

/** The text of the socket-unit heredoc the installer writes. */
function socketUnitBlock(s) {
  const start = s.indexOf("sudo tee /etc/systemd/system/crow-gateway-proxy.socket");
  const end = s.indexOf("\nSOCKETEOF\n", start);
  return start === -1 || end === -1 ? "" : s.slice(start, end);
}

test("proxy socket: systemd owns it — root:caddy 0660 on /run/crow-proxy, enabled before the gateway", () => {
  const s = src();
  const unit = socketUnitBlock(s);
  assert.ok(unit, "the installer must write /etc/systemd/system/crow-gateway-proxy.socket");
  assert.match(unit, /^ListenStream=\/run\/crow-proxy\/gateway\.sock$/m);
  assert.match(unit, /^SocketUser=root$/m);
  assert.match(unit, /^SocketGroup=caddy$/m);
  assert.match(unit, /^SocketMode=0660$/m);
  assert.match(unit, /^DirectoryMode=0755$/m);
  assert.match(unit, /^WantedBy=sockets\.target$/m);
  // Without Service= the socket points at a nonexistent crow-gateway-proxy.service and cannot start (review).
  assert.match(unit, /^Service=crow-gateway\.service$/m);
  // The socket is started before the gateway that consumes its fd.
  const socketIdx = s.indexOf("systemctl enable --now crow-gateway-proxy.socket");
  const gatewayIdx = s.indexOf("systemctl restart crow-gateway\n");
  assert.ok(socketIdx > -1 && gatewayIdx > -1 && socketIdx < gatewayIdx, "socket first, then the gateway");
});

test("proxy socket: the gateway unit takes it by activation and owns no runtime dir", () => {
  const s = src();
  const unit = gatewayUnitBlock(s);
  // Sockets= is a [Service] key; in [Unit] systemd ignores it and passes no fd (review).
  const svc = unit.slice(unit.indexOf("[Service]"), unit.indexOf("[Install]"));
  assert.match(svc, /^Sockets=crow-gateway-proxy\.socket$/m);
  assert.doesNotMatch(unit.slice(0, unit.indexOf("[Service]")), /^Sockets=/m);
  assert.match(unit, /^Requires=crow-gateway-proxy\.socket$/m);
  assert.match(unit, /^After=crow-gateway-proxy\.socket$/m);
  // The old gateway-owned socket setup is gone: no runtime dir, no env path.
  assert.doesNotMatch(s, /^RuntimeDirectory=crow$/m);
  assert.doesNotMatch(s, /^RuntimeDirectoryMode=0750$/m);
  assert.doesNotMatch(unit, /RuntimeDirectory=crow/);
  assert.doesNotMatch(s, /CROW_PROXY_SOCKET/);
  // ...and the gateway's user is never added to the caddy service user's group.
  assert.doesNotMatch(s, /usermod -aG "\$USER" caddy/);
});

test("proxy socket: Caddy dials the unix socket, never loopback with forwarded headers", () => {
  const s = src();
  assert.match(s, /reverse_proxy unix\/\/run\/crow-proxy\/gateway\.sock/);
  assert.doesNotMatch(s, /reverse_proxy (localhost|127\.0\.0\.1):3001/);
});

test("fix-caddy-proxy-socket.sh: bash -n parses", () => {
  execFileSync("bash", ["-n", FIX_SCRIPT]);
});

test("fix-caddy-proxy-socket.sh: shellcheck passes when available (skips otherwise)", (t) => {
  const which = spawnSync("shellcheck", ["--version"], { stdio: "ignore" });
  if (which.error) return t.skip("shellcheck not installed");
  const r = spawnSync("shellcheck", [FIX_SCRIPT], { encoding: "utf-8" });
  assert.equal(r.status, 0, r.stdout);
});

test("fix-caddy-proxy-socket.sh: installs the socket unit + drop-in, restarts Caddy, verifies /health", () => {
  const s = fixSrc();
  // Idempotent: BOTH facts — the unit file and the gateway's Sockets= — stop it.
  assert.match(s, /Already set up/);
  assert.match(s, /systemctl show -p Sockets --value/);
  // The socket unit itself, with the same ownership the installer writes.
  assert.match(s, /SOCKET_UNIT="\/etc\/systemd\/system\/\$SOCKET_UNIT_NAME"/);
  assert.match(s, /^ListenStream=\/run\/crow-proxy\/gateway\.sock$/m);
  assert.match(s, /^SocketUser=root$/m);
  assert.match(s, /^SocketGroup=caddy$/m);
  assert.match(s, /^SocketMode=0660$/m);
  // The three unit lines go in through the drop-in, not a rewritten unit file.
  assert.match(s, /DROP_IN="\$DROP_IN_DIR\/proxy-socket\.conf"/);
  const dropIn = s.slice(s.indexOf('cat > "$DROP_IN"'), s.indexOf("\nEOF\n", s.indexOf('cat > "$DROP_IN"')));
  assert.match(dropIn.slice(dropIn.indexOf("[Service]")), /^Sockets=crow-gateway-proxy\.socket$/m, "Sockets= under [Service]");
  assert.doesNotMatch(dropIn.slice(0, dropIn.indexOf("[Service]")), /^Sockets=/m);
  assert.match(s, /^Service=crow-gateway\.service$/m);
  assert.match(s, /^Requires=crow-gateway-proxy\.socket$/m);
  assert.match(s, /^After=crow-gateway-proxy\.socket$/m);
  // Only the loopback dial line is rewritten (the sed target), and both halves
  // of the rewrite are asserted before anything is restarted.
  assert.match(s, /sed -E .*localhost\|127\\\.0\\\.0\\\.1.*unix\/\/run\/crow-proxy\/gateway\.sock/);
  assert.match(s, /if grep -Eq "\$LOOPBACK_RE" "\$CADDYFILE"/);
  assert.match(s, /if ! grep -Eq "\$UNIX_RE" "\$CADDYFILE"/);
  assert.match(s, /caddy validate --config "\$CADDYFILE"/);
  // Backups before any change, and a restore trap that says so.
  assert.match(s, /cp -a "\$CADDYFILE" "\$BACKUP_DIR\/Caddyfile"/);
  assert.match(s, /trap restore ERR/);
  assert.match(s, /restoring the previous setup/);
  // Service sequence: daemon-reload, the socket, the gateway, then a FULL Caddy restart.
  assert.match(s, /systemctl daemon-reload/);
  assert.match(s, /systemctl enable --now "\$SOCKET_UNIT_NAME"/);
  assert.match(s, /systemctl restart "\$GATEWAY_UNIT_NAME"/);
  assert.match(s, /systemctl restart caddy/);
  assert.doesNotMatch(s, /reload caddy/);
  // Verification: /health through Caddy for the Caddyfile's own site, 200 or undo.
  assert.match(s, /--resolve "\$SITE_HOST:\$SITE_PORT:127\.0\.0\.1"/);
  assert.match(s, /https:\/\/\$SITE_HOST:\$SITE_PORT\/health/);
  assert.match(s, /if \[ "\$HEALTH_CODE" != "200" \]/);
  // The gateway user comes from systemd, and the caddy user/group are guarded.
  assert.match(s, /systemctl show -p User --value "\$GATEWAY_UNIT_NAME"/);
  assert.match(s, /id "\$CADDY_GROUP"/);
  assert.match(s, /getent group "\$CADDY_GROUP"/);
  // No group membership is changed any more.
  assert.doesNotMatch(s, /usermod/);
});

test("proxy socket units pass systemd-analyze verify when available (skips otherwise)", (t) => {
  const which = spawnSync("systemd-analyze", ["--version"], { stdio: "ignore" });
  if (which.error) return t.skip("systemd-analyze not installed");
  const s = src();
  const sock = socketUnitBlock(s).replace(/^.*\n/, "");
  const g = gatewayUnitBlock(s);
  const svc = g.slice(g.indexOf("[Unit]"), g.indexOf("\nEOF\n"))
    .replaceAll("$USER", process.env.USER || "nobody").replaceAll("$CROW_APP", "/tmp")
    .replaceAll("$(which node)", process.execPath).replaceAll("$CROW_DATA", "/tmp")
    .replace(/^Requires=docker\.service$/m, "").replace(/^After=.*docker.*$/m, "");
  const dir = mkdtempSync(join(tmpdir(), "crow-units-"));
  writeFileSync(join(dir, "crow-gateway-proxy.socket"), sock + "\n");
  writeFileSync(join(dir, "crow-gateway.service"), svc + "\n");
  const r = spawnSync("systemd-analyze", ["verify", "--man=no", join(dir, "crow-gateway-proxy.socket"), join(dir, "crow-gateway.service")], { encoding: "utf-8" });
  const out = (r.stdout || "") + (r.stderr || "");
  assert.doesNotMatch(out, /Unknown key name|cannot be started|not loaded/, out);
});
