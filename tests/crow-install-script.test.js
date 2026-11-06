import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "crow-install.sh");
const src = () => readFileSync(SCRIPT, "utf-8");

/** Source the installer's helper layer (CROW_INSTALL_SOURCE_ONLY=1) and run a
 *  snippet against it. detached:true puts the child in a new session with no
 *  controlling terminal, so the /dev/tty open-probe fails → HAS_TTY=false and
 *  the headless path is exercised even from an interactive terminal.
 *  scriptArgs are passed to `source`, i.e. they become the installer's own
 *  arguments (the `curl … | bash -s -- --no-auto-updates` case). */
function runWithHelpers(snippet, env = {}, scriptArgs = []) {
  // Safety rail: a snippet that can reach the auto-updates step may only run
  // with the scratch seams, so a regression in the env parsing can never run a
  // real `sudo apt install` (or hang on a sudo prompt) on the suite's machine.
  if (/install_auto_updates|apt_install|write_crow_apt_conf|write_auto_upgrades_conf/.test(snippet)) {
    for (const key of ["APT_CONF_DIR", "CROW_SUDO", "CROW_APT"]) {
      if (!env[key]) throw new Error(`${key} is required to run the auto-updates step in a test`);
    }
  }
  const args = scriptArgs.map((a) => ` ${a}`).join("");
  return spawnSync("bash", ["-c", `set -euo pipefail; CROW_INSTALL_SOURCE_ONLY=1 source "${SCRIPT}"${args}; ${snippet}`], {
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
  assert.ok(callIdx < s.indexOf("Step 1/10"), "the gate must run before Step 1 (first apt mutation)");
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
  const dockerStep = s.slice(s.indexOf('header "Step 3/10: Docker"'), s.indexOf('header "Step 4/10: Caddy"'));
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
  const step2 = s.indexOf('header "Step 2/10: Node.js');
  const step3 = s.indexOf('header "Step 3/10: Docker"');
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

test("boot guard (N1c-3 L1): the generated unit runs the launcher copy twice and covers npm", () => {
  const s = src();
  const unit = gatewayUnitBlock(s);
  // ExecStartPre runs before EVERY start (including every automatic restart),
  // ExecStopPost records how that start ended — from a copy OUTSIDE the tree.
  // Every path is quoted by sd_quote, which also doubles a literal % (systemd
  // would otherwise read it as a specifier).
  assert.match(unit,
    /^ExecStartPre=-\$\(sd_quote "\$\(which node\)"\) \$\(sd_quote "\$CROW_HOME\/boot-guard\/crow-boot-guard\.mjs"\) --app-root \$\(sd_quote "\$CROW_APP"\)$/m);
  assert.match(unit,
    /^ExecStopPost=-\$\(sd_quote "\$\(which node\)"\) \$\(sd_quote "\$CROW_HOME\/boot-guard\/crow-boot-guard\.mjs"\) --app-root \$\(sd_quote "\$CROW_APP"\) --record-exit$/m);
  // TimeoutStartSec must cover the guard's own npm install (up to 5 minutes).
  assert.match(unit, /^TimeoutStartSec=15min$/m);
  assert.match(unit, /^Environment=CROW_BOOT_GUARD=1$/m);
  // The launcher must be installed from the checkout into CROW_HOME before the
  // unit is started, and the drop-in must never name the tree's own copy.
  assert.match(s, /install -m 600 scripts\/boot-guard\/crow-boot-guard\.mjs "\$CROW_HOME\/boot-guard\/crow-boot-guard\.mjs"/);
  assert.ok(s.indexOf("install -m 600 scripts/boot-guard/crow-boot-guard.mjs") < s.indexOf("sudo tee /etc/systemd/system/crow-gateway.service"),
    "the launcher copy must exist before the unit that runs it is written");
});

test("sd_quote: quotes a path, doubles a literal %, and escapes a quote", () => {
  // The unit lines are written through sd_quote. A path with a space would split
  // into two arguments; a raw % is a systemd specifier and the guard would exit
  // before stamping, which the installer (not the operator) caused.
  const r = runWithHelpers(`sd_quote '/home/u/crow 100%'; printf '\\n'; sd_quote '/home/u/a"b'; printf '\\n'`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split("\n"), ['"/home/u/crow 100%%"', '"/home/u/a\\"b"']);
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
    .replaceAll("$CROW_HOME", "/tmp/crow-home")
    // The heredoc is unquoted, so sd_quote runs at install time; here its
    // argument is already substituted, so drop the wrapper and keep the quoting.
    .replace(/\$\(sd_quote ("[^"]*")\)/g, "$1")
    .replace(/^Requires=docker\.service$/m, "").replace(/^After=.*docker.*$/m, "");
  const dir = mkdtempSync(join(tmpdir(), "crow-units-"));
  writeFileSync(join(dir, "crow-gateway-proxy.socket"), sock + "\n");
  writeFileSync(join(dir, "crow-gateway.service"), svc + "\n");
  const r = spawnSync("systemd-analyze", ["verify", "--man=no", join(dir, "crow-gateway-proxy.socket"), join(dir, "crow-gateway.service")], { encoding: "utf-8" });
  const out = (r.stdout || "") + (r.stderr || "");
  assert.doesNotMatch(out, /Unknown key name|cannot be started|not loaded/, out);
});

// ─── Automatic security updates (security audit K6) ──────────────────────────
// The step wires unattended-upgrades to the repos this installer added (Node,
// Docker, Caddy) with automatic reboots OFF. Everything below either reads the
// script or runs the step against a SCRATCH apt.conf.d with shims for sudo/apt,
// so it can never touch the real /etc/apt of the machine running the suite.

/** The step's own text: its header up to the mDNS step that follows it. */
function autoUpdatesStepBlock(s) {
  const start = s.indexOf('header "Step 5/10: Automatic Security Updates"');
  const end = s.indexOf('header "Step 6/10: mDNS (crow.local)"');
  return start === -1 || end === -1 ? "" : s.slice(start, end);
}

/** Every helper the step can run (they sit above the source-only seam). */
function autoUpdatesHelpers(s) {
  const start = s.indexOf("# ─── Automatic security updates (security audit K6)");
  const end = s.indexOf("# Test seam: tests source the helpers");
  return start === -1 || end === -1 ? "" : s.slice(start, end);
}

/** The origin lines the operator confirmed from each repo's live Release file. */
const ORIGIN_LINES = [
  '"origin=. nodistro,codename=nodistro";',
  '"origin=Docker,archive=${distro_codename}";',
  '"origin=cloudsmith/caddy/stable,codename=any-version";',
];

/** A scratch "root": an empty apt.conf.d plus shims for sudo and apt. */
function autoUpdatesScratch() {
  const dir = mkdtempSync(join(tmpdir(), "crow-autoupdates-"));
  const confDir = join(dir, "apt.conf.d");
  mkdirSync(confDir);
  const aptLog = join(dir, "apt.log");
  // apt shim: records its arguments and succeeds — no package is installed.
  const apt = join(dir, "apt-shim");
  writeFileSync(apt, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(aptLog)}\n`, { mode: 0o755 });
  // sudo shim: runs the command as this user (the scratch dir needs no root).
  const sudo = join(dir, "sudo-shim");
  writeFileSync(sudo, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  return { dir, confDir, aptLog, apt, sudo };
}

/** Run the step against a scratch root through the path/command seams. */
function runAutoUpdates(scratch, opts = {}) {
  return runWithHelpers(opts.snippet || "install_auto_updates", {
    APT_CONF_DIR: scratch.confDir,
    CROW_SUDO: scratch.sudo,
    CROW_APT: scratch.apt,
    ...(opts.env || {}),
  }, opts.args || []);
}

test("K6: the step sits after Docker and Caddy and runs install_auto_updates", () => {
  const s = src();
  const step = autoUpdatesStepBlock(s);
  assert.ok(step, "there must be a Step 5/10: Automatic Security Updates");
  assert.match(step, /^install_auto_updates$/m);
  // Its origins only exist once Docker's and Caddy's apt repos are configured.
  assert.ok(
    s.indexOf('header "Step 3/10: Docker"') < s.indexOf('header "Step 5/10: Automatic Security Updates"')
      && s.indexOf('header "Step 4/10: Caddy"') < s.indexOf('header "Step 5/10: Automatic Security Updates"'),
    "the auto-updates step must come after Docker and Caddy",
  );
});

test("K6: Crow's origins file carries exactly the three origins and Automatic-Reboot false", () => {
  const helpers = autoUpdatesHelpers(src());
  assert.ok(helpers, "the step's helpers must be defined above the source-only seam");
  const writer = helpers.slice(helpers.indexOf("write_crow_apt_conf()"), helpers.indexOf("write_auto_upgrades_conf()"));
  const originLines = writer.split("\n").map((l) => l.trim()).filter((l) => l.startsWith('"origin='));
  // Exactly three, exactly as read from each repo's Release file: an invented
  // origin (or a fourth line repeating the distro's own security origins) would
  // silently widen or narrow what installs itself.
  assert.deepEqual(originLines, ORIGIN_LINES);
  assert.match(writer, /^Unattended-Upgrade::Automatic-Reboot "false";$/m);
  assert.match(writer, /52crow-unattended-upgrades/);
  // The distro's own file is never written or edited.
  assert.doesNotMatch(src(), /50unattended-upgrades["' ]*>/);
});

test("K6 (behaviour): the step installs unattended-upgrades and writes both files in a scratch root", () => {
  const scratch = autoUpdatesScratch();
  const r = runAutoUpdates(scratch);
  assert.equal(r.status, 0, r.stderr);

  const origins = readFileSync(join(scratch.confDir, "52crow-unattended-upgrades"), "utf-8");
  const originLines = origins.split("\n").map((l) => l.trim()).filter((l) => l.startsWith('"origin='));
  assert.deepEqual(originLines, ORIGIN_LINES);
  assert.match(origins, /^Unattended-Upgrade::Automatic-Reboot "false";$/m);

  assert.equal(
    readFileSync(join(scratch.confDir, "20auto-upgrades"), "utf-8"),
    'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n',
  );
  // The distro package is installed through apt with the script's own -y style.
  assert.match(readFileSync(scratch.aptLog, "utf-8"), /install -y unattended-upgrades/);
});

test("K6 (behaviour): re-running rewrites 52crow only when its content differs", () => {
  const scratch = autoUpdatesScratch();
  assert.equal(runAutoUpdates(scratch).status, 0);
  const dest = join(scratch.confDir, "52crow-unattended-upgrades");
  const before = statSync(dest);
  const second = runAutoUpdates(scratch);
  assert.equal(second.status, 0, second.stderr);
  const after = statSync(dest);
  // The step compares first and skips install(1) entirely when the bytes match,
  // so the destination's inode (and mtime) must be untouched.
  assert.equal(after.ino, before.ino, "an identical file must not be rewritten");
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.match(second.stdout, /already configured/);
});

test("K6 (behaviour): 20auto-upgrades is written only when it is absent", () => {
  const scratch = autoUpdatesScratch();
  const conf = join(scratch.confDir, "20auto-upgrades");
  writeFileSync(conf, 'APT::Periodic::Unattended-Upgrade "0";\n');
  const r = runAutoUpdates(scratch);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(conf, "utf-8"), 'APT::Periodic::Unattended-Upgrade "0";\n',
    "an existing periodic switch is never overruled");
  assert.match(r.stdout, /already exists/);
});

test("K6 (behaviour): CROW_NO_AUTO_UPDATES=1 skips the step — no apt call, no file written", () => {
  const scratch = autoUpdatesScratch();
  const r = runAutoUpdates(scratch, { env: { CROW_NO_AUTO_UPDATES: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skipped/);
  assert.deepEqual(readdirSync(scratch.confDir), []);
  assert.equal(existsSync(scratch.aptLog), false, "the opt-out must not run apt at all");
});

test("K6 (behaviour): the --no-auto-updates argument given to the script skips the step", () => {
  const scratch = autoUpdatesScratch();
  // `source … --no-auto-updates` is what `curl … | bash -s -- --no-auto-updates`
  // does: the arguments reach the script's own flag loop.
  const r = runAutoUpdates(scratch, {
    args: ["--no-auto-updates"],
    snippet: 'echo "AUTO=$AUTO_UPDATES"; install_auto_updates',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /AUTO=false/);
  assert.match(r.stdout, /skipped/);
  assert.deepEqual(readdirSync(scratch.confDir), []);
  assert.equal(existsSync(scratch.aptLog), false, "the opt-out must not run apt at all");
});

test("K6: the step can only run in tests with the scratch seams set", () => {
  // The rail in runWithHelpers: without it a broken env parse would run the
  // suite's machine's real `sudo apt install unattended-upgrades`.
  assert.throws(
    () => runWithHelpers("install_auto_updates", { CROW_NO_AUTO_UPDATES: "1" }),
    /APT_CONF_DIR is required/,
  );
});

test("K6: the flag and CROW_NO_AUTO_UPDATES are parsed next to --yes and documented in the usage text", () => {
  const s = src();
  assert.match(s, /--no-auto-updates\) AUTO_UPDATES=false ;;/);
  assert.match(s, /CROW_NO_AUTO_UPDATES:-\}" = "1" \]; then AUTO_UPDATES=false; fi/);
  const usage = s.slice(0, s.indexOf("set -euo pipefail"));
  assert.match(usage, /^#   --no-auto-updates/m,
    "the opt-out belongs in the script's usage text");
  // Both pipe forms: the documented one-liner feeds the script to bash on
  // stdin, so a flag cannot be appended after the URL.
  assert.match(usage, /crow-install\.sh \| bash -s -- --no-auto-updates/);
  assert.match(usage, /crow-install\.sh \| CROW_NO_AUTO_UPDATES=1 bash/);
  const scratch = autoUpdatesScratch();
  const r = runAutoUpdates(scratch, {
    env: { CROW_NO_AUTO_UPDATES: "1" },
    snippet: 'echo "AUTO=$AUTO_UPDATES"; install_auto_updates',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /AUTO=false/);
  assert.match(r.stdout, /skipped/);
});

test("K6: every apt call after this step waits for the dpkg lock", () => {
  const s = src();
  const stepIdx = s.indexOf('header "Step 5/10: Automatic Security Updates"');
  assert.ok(stepIdx > -1, "the step must exist");
  // From here on apt-daily-upgrade.timer can hold the dpkg lock (20auto-upgrades
  // says "1"); without the timeout apt fails and `set -e` stops the install.
  const later = s.slice(stepIdx);
  const calls = later.match(/^\s*(?:sudo\s+)?(?:apt|apt-get)\s+(?:-y\s+)?(?:install|update|upgrade)\b.*$/gm) || [];
  assert.ok(calls.length >= 3, `expected the later apt calls, found ${calls.length}`);
  for (const line of calls) {
    assert.match(line, /-o DPkg::Lock::Timeout=300/, `missing the lock timeout: ${line.trim()}`);
  }
  // The step's own install runs before the timer is switched on, so it needs none.
  assert.doesNotMatch(autoUpdatesStepBlock(s), /DPkg::Lock::Timeout/);
});

test("K6: the step never restarts a service and never reboots", () => {
  const s = src();
  for (const block of [autoUpdatesStepBlock(s), autoUpdatesHelpers(s)]) {
    assert.ok(block, "block must exist");
    assert.doesNotMatch(block, /systemctl/, "no service is restarted or reloaded by this step");
    assert.doesNotMatch(block, /shutdown/, "no shutdown either");
    // A reboot COMMAND is forbidden; the Automatic-Reboot setting is not a reboot.
    assert.doesNotMatch(block, /^\s*(sudo\s+)?(reboot|systemctl\s+reboot)\s*$/m);
  }
  assert.match(autoUpdatesHelpers(s), /Automatic-Reboot "false"/);
  // …and apt never runs non-interactively in a way that takes a reboot itself.
  assert.doesNotMatch(autoUpdatesHelpers(s), /Needrestart|needrestart -r/);
});

// ─── Security audit N1c-15: firewall first, port precheck, honest ending ─────
// The audit saw three things on one half-finished install (INSTALL_EXIT=0):
// the gateway and Caddy enabled/restarted BEFORE ufw came up, no check that
// 3001/80/443 were free, and "Crow is ready!" printed right after
// "Gateway did not respond …". Everything below either reads the script or
// runs a helper against a SCRATCH PATH/HOME (a fake ss/systemctl/curl/sleep),
// so no test can see the real socket table, service manager or Crow install.

/** Write an executable shim called `name` into `dir`. */
function shim(dir, name, body) {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return join(dir, name);
}

/** A scratch PATH dir + HOME for the precheck helpers: `ss` reports ONLY the
 *  ports this test pretends are busy, `systemctl` knows ONLY the units this
 *  test pretends are active, and `rerun` creates $HOME/.crow/app so the script
 *  takes its "Crow is already cloned" path. */
function portScratch({ busy = [], active = [], rerun = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-ports-"));
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(bin);
  mkdirSync(home);
  const ssCases = busy.map((p) => `    *:${p}*) echo "LISTEN 0 4096 0.0.0.0:${p} 0.0.0.0:*" ;;`).join("\n");
  shim(bin, "ss", `case "$*" in\n${ssCases}\n  *) : ;;\nesac\nexit 0`);
  const unitCases = active.map((u) => `    *${u}*) exit 0 ;;`).join("\n");
  shim(bin, "systemctl", `case "$*" in\n${unitCases}\n  *) : ;;\nesac\nexit 1`);
  if (rerun) mkdirSync(join(home, ".crow", "app"), { recursive: true });
  return { dir, bin, home, env: { PATH: `${bin}:${process.env.PATH}`, HOME: home } };
}

test("N1c-15: the firewall is up BEFORE crow-gateway and Caddy are enabled/started", () => {
  const s = src();
  const enable = s.search(/^sudo ufw --force enable$/m);
  assert.ok(enable > -1, "the step must still enable ufw with --force, not a piped echo");
  // Every rule the step needs must be in place BEFORE the firewall opens — a
  // rule added afterwards is a window with the door open, and SSH in
  // particular is the difference between a remote install and a lockout.
  for (const rule of [
    /^sudo ufw default deny incoming$/m,
    /^sudo ufw default allow outgoing$/m,
    /^sudo ufw allow 22\/tcp comment 'SSH'$/m,
    /^  sudo ufw allow 443\/tcp comment 'HTTPS \(Caddy\)'$/m,
  ]) {
    const idx = s.search(rule);
    assert.ok(idx > -1, `rule/step missing: ${rule}`);
    assert.ok(idx < enable, `must sit above \`ufw --force enable\`: ${rule}`);
  }
  // ufw-docker closes the Docker/UFW hole (a container's published port bypasses
  // ufw), so it belongs to the same "before anything listens" window.
  const dockerFixIdx = s.search(/^  sudo ufw-docker install$/m);
  assert.ok(dockerFixIdx > -1, "the ufw-docker step must still be there");
  // The audit's finding: the units were enabled and restarted first, so a
  // half-finished install listened on 3001/443 with no firewall in front of it.
  for (const re of [
    /^sudo systemctl enable crow-gateway$/m,
    /^sudo systemctl restart crow-gateway\n/m,
    /^sudo systemctl restart caddy$/m,
  ]) {
    const idx = s.search(re);
    assert.ok(idx > -1, `expected to find ${re}`);
    assert.ok(enable < idx, `the firewall must be enabled before: ${re}`);
    assert.ok(dockerFixIdx < idx, `ufw-docker must be installed before: ${re}`);
  }
  // The gateway's socket unit belongs to the same activation sequence.
  const socketIdx = s.indexOf("systemctl enable --now crow-gateway-proxy.socket");
  assert.ok(socketIdx > -1 && enable < socketIdx, "the firewall must come up before the socket unit too");
});

test("N1c-15: the port precheck runs before Step 1 — nothing is installed or started first", () => {
  const s = src();
  const callIdx = s.search(/^if ! check_ports_free; then$/m);
  assert.ok(callIdx > -1, "the install body must call check_ports_free");
  const step1 = s.indexOf('header "Step 1/10: System Updates"');
  assert.ok(step1 > -1 && callIdx < step1, "the precheck must sit above the first install step");
  const firstApt = s.search(/^sudo apt update$/m);
  assert.ok(firstApt > -1 && callIdx < firstApt, "…and above the first apt call");
  // Below the source-only seam, i.e. this is the executed body, not the helper.
  assert.ok(callIdx > s.indexOf("CROW_INSTALL_SOURCE_ONLY"), "the call must be in the install body");
  assert.match(s.slice(callIdx, s.indexOf("\nfi\n", callIdx)), /exit 1/);
});

/** A scratch PATH for ssh_ports: `sudo` runs its argument (exactly what the
 *  script's own helper does, and it can never ask for a password), `ss` prints
 *  exactly the socket table this test pretends to see. Nothing here can reach
 *  the real socket table or /etc/ssh. */
function sshScratch(ssOutput = "") {
  const dir = mkdtempSync(join(tmpdir(), "crow-sshports-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  shim(bin, "sudo", 'exec "$@"');
  writeFileSync(join(bin, "ss"), `#!/bin/sh\ncat <<'SSEOF'\n${ssOutput}\nSSEOF\n`, { mode: 0o755 });
  return { dir, bin, env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir } };
}

/** An sshd_config fixture — the config-path seam means /etc/ssh is never read. */
function sshdConfigFixture(lines) {
  const dir = mkdtempSync(join(tmpdir(), "crow-sshconf-"));
  const p = join(dir, "sshd_config");
  writeFileSync(p, lines);
  return p;
}

/** One `ss -ltnHp` row: <local address:port> owned by <process>. */
function ssRow(addr, proc) {
  return `LISTEN 0 4096 ${addr} ${addr} users:(("${proc}",pid=812,fd=3))`;
}

test("N1c-15: ssh_ports falls through a silent ss to SSH_CONNECTION and sshd's Port lines", () => {
  // `ss` prints nothing here (a box where the users: column is unavailable), so
  // the two root-free probes must still answer.
  const scratch = sshScratch("");
  // Commented `#Port 22` must stay out (Debian/Ubuntu ship the default that way).
  const cfg = sshdConfigFixture("#Port 22\nPort 2222\n  Port 2200\nPubkeyAuthentication yes\n");
  const viaConf = runWithHelpers(`ssh_ports "${cfg}"`, { ...scratch.env, SSH_CONNECTION: "" });
  assert.equal(viaConf.status, 0, viaConf.stderr);
  assert.deepEqual(viaConf.stdout.trim().split("\n"), ["2222", "2200"]);
  // SSH_CONNECTION's 4th field is the port this very session arrived on — the
  // one the operator would be cut off from the moment ufw came up.
  const viaEnv = runWithHelpers(`ssh_ports "${cfg}"`, {
    ...scratch.env,
    SSH_CONNECTION: "100.64.20.5 51234 100.64.20.9 2200",
  });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.deepEqual(viaEnv.stdout.trim().split("\n").sort(), ["2200", "2222"]);
  // A missing config file is not an error, and an unset SSH_CONNECTION prints nothing.
  const none = runWithHelpers("ssh_ports /definitely/not/sshd_config", { ...scratch.env, SSH_CONNECTION: "" });
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout.trim(), "");
});

test("N1c-15: ssh_ports takes the listeners sshd really has — the socket-activated port with no Port line", () => {
  // Ubuntu 22.10+ activates sshd from ssh.socket, so a custom port lives in a
  // ListenStream= drop-in: no `Port` line exists anywhere and the config file is
  // silent. Only the real socket table has it. Every local-address shape has to
  // yield the port from the address column, and the dual-stack pair comes out once.
  const scratch = sshScratch([
    ssRow("0.0.0.0:2222", "sshd"),
    ssRow("[::]:2222", "sshd"),
    ssRow("*:2200", "sshd"),
  ].join("\n"));
  const cfg = sshdConfigFixture("#Port 22\nListenAddress 0.0.0.0\n");
  const r = runWithHelpers(`ssh_ports "${cfg}"`, { ...scratch.env, SSH_CONNECTION: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["2222", "2200"]);
});

test("N1c-15: ssh_ports only takes listeners whose process is sshd", () => {
  const cfg = sshdConfigFixture("");
  // A non-sshd listener alone yields nothing from that probe. (This is the
  // filter's own guard: without the sshd match every listener — Caddy, Docker's
  // proxy — would become an "SSH port".)
  const onlyForeign = sshScratch(ssRow("0.0.0.0:8443", "docker-proxy"));
  const a = runWithHelpers(`ssh_ports "${cfg}"`, { ...onlyForeign.env, SSH_CONNECTION: "" });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout.trim(), "", "a non-sshd listener is not an SSH port");

  // Mixed table: the foreign rows stay out, the sshd row comes in. This half is
  // what the pre-change script fails — it had no ss probe at all, so it printed
  // nothing for a host whose sshd port is only visible in the socket table.
  const mixed = sshScratch([
    ssRow("0.0.0.0:8443", "docker-proxy"),
    ssRow("[::]:2222", "sshd"),
  ].join("\n"));
  const b = runWithHelpers(`ssh_ports "${cfg}"`, { ...mixed.env, SSH_CONNECTION: "" });
  assert.equal(b.status, 0, b.stderr);
  assert.deepEqual(b.stdout.trim().split("\n"), ["2222"]);
});

test("N1c-15: ssh_ports matches the Port keyword case-insensitively (sshd keywords are)", () => {
  const scratch = sshScratch("");
  const cfg = sshdConfigFixture("PORT 2200\nPubkeyAuthentication yes\n");
  const r = runWithHelpers(`ssh_ports "${cfg}"`, { ...scratch.env, SSH_CONNECTION: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["2200"]);
});

test("N1c-15: ssh_ports stops at the first Match line — a Port there is invalid for sshd", () => {
  const scratch = sshScratch("");
  const cfg = sshdConfigFixture("Port 2222\nMatch Address 100.64.20.0/24\n  Port 2299\n");
  const r = runWithHelpers(`ssh_ports "${cfg}"`, { ...scratch.env, SSH_CONNECTION: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["2222"]);
});

test("N1c-15: ssh_ports drops ports outside 1-65535 (ufw allow 99999/tcp would fail under set -e)", () => {
  const scratch = sshScratch(ssRow("0.0.0.0:99999", "sshd"));
  const cfg = sshdConfigFixture("Port 99999\nPort 0\nPort 65536\nPort 2222\nPORT 65535\n");
  const r = runWithHelpers(`ssh_ports "${cfg}"`, {
    ...scratch.env,
    SSH_CONNECTION: "100.64.20.5 51234 100.64.20.9 99999",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["2222", "65535"]);
});

test("N1c-15: ssh_ports prints each port once (SSH_CONNECTION, ss and the config agree)", () => {
  const scratch = sshScratch([
    ssRow("0.0.0.0:2222", "sshd"),
    ssRow("[::]:2222", "sshd"),
  ].join("\n"));
  const cfg = sshdConfigFixture("Port 2222\nPort 22\n");
  const r = runWithHelpers(`ssh_ports "${cfg}"`, {
    ...scratch.env,
    SSH_CONNECTION: "100.64.20.5 51234 100.64.20.9 2222",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["2222", "22"]);
});

test("N1c-15: the sshd listener probe uses the script's sudo helper, never a fresh prompt", () => {
  const s = src();
  assert.ok(s.includes("sudo_cmd ss -ltnHp"), "the ss probe must go through sudo_cmd (the script's own seam)");
  // sudo is already obtained by then: Step 1's first privileged call, and the
  // plain `sudo ufw` rules directly above the call site, keep the timestamp fresh.
  const callSite = s.indexOf('SSH_EXTRA_PORTS="$(ssh_ports)"');
  assert.ok(callSite > -1, "the firewall step must call ssh_ports");
  const firstSudo = s.indexOf("sudo apt update");
  assert.ok(firstSudo > -1 && firstSudo < callSite, "Step 1's `sudo apt update` runs first");
  const sshAllow = s.search(/^sudo ufw allow 22\/tcp comment 'SSH'$/m);
  assert.ok(sshAllow > -1 && sshAllow < callSite, "the unconditional SSH allow sits above the probe");
});

test("N1c-15 (behaviour): a foreign listener on :443 stops the install with plain words and exit 1", () => {
  const scratch = portScratch({ busy: [443] });
  const r = runWithHelpers("check_ports_free", scratch.env);
  assert.equal(r.status, 1, `a busy port must be a non-zero exit:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /Port 443 is already in use by another program/);
  assert.match(r.stdout, /see: sudo ss -ltnp 'sport = :443'/);
  assert.match(r.stdout, /Stop that program or free the port, then run the installer again\./);
  // 3001 and 80 were free in this fixture: nothing else is reported.
  assert.doesNotMatch(r.stdout, /Port 3001/);
  assert.doesNotMatch(r.stdout, /Port 80 /);
});

test("N1c-15 (behaviour): free ports pass, and a re-run does not trip over Crow's own services", () => {
  const free = portScratch({ busy: [] });
  const clean = runWithHelpers("check_ports_free && echo PORTS_OK", free.env);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /PORTS_OK/);

  // A second run: the gateway (3001) and Caddy (80/443) the installer itself
  // started are listening — re-installing must not call that "another program".
  const rerun = portScratch({ busy: [3001, 80, 443], active: ["crow-gateway", "caddy"], rerun: true });
  const again = runWithHelpers("check_ports_free && echo PORTS_OK", rerun.env);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /PORTS_OK/);

  // …but the same listener with NO Crow checkout on disk is a foreign program,
  // even if a unit happens to share the name: only the re-run path is trusted.
  const noCheckout = portScratch({ busy: [443], active: ["caddy"] });
  const foreign = runWithHelpers("check_ports_free", noCheckout.env);
  assert.equal(foreign.status, 1, foreign.stdout + foreign.stderr);
  assert.match(foreign.stdout, /Port 443 is already in use/);
});

test("N1c-15 (behaviour): any `error` withholds the ready banner (install_failed)", () => {
  const clean = runWithHelpers('if install_failed; then echo BANNER; else echo NO_BANNER; fi');
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout.trim(), "NO_BANNER", "a run without errors stays ready-able");
  const failed = runWithHelpers('error "Gateway did not respond"; if install_failed; then echo NO_BANNER; else echo BANNER; fi; echo "ERRORS=${INSTALL_ERRORS}"');
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.stdout, /NO_BANNER/);
  assert.match(failed.stdout, /ERRORS=1/);
});

test("N1c-15 (behaviour): a failed health check names the next steps and returns non-zero", () => {
  // Behavioural, not static: verify_gateway runs against shims — systemctl says
  // inactive, curl never answers, sleep is a no-op — so there is no 20s wait
  // and no contact with the real gateway.
  const scratch = portScratch({ active: [] });
  shim(scratch.bin, "curl", "exit 7");
  shim(scratch.bin, "sleep", "exit 0");
  const r = runWithHelpers('if verify_gateway; then echo READY_BANNER; else echo NO_BANNER; fi', scratch.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NO_BANNER/, "verify_gateway must fail when the health endpoint never answers");
  assert.doesNotMatch(r.stdout, /READY_BANNER/);
  assert.match(r.stdout, /Gateway did not respond at http:\/\/localhost:3001 after 10 attempts/);
  assert.match(r.stdout, /sudo systemctl status crow-gateway/);
  assert.match(r.stdout, /sudo journalctl -u crow-gateway -n 50/);
  assert.match(r.stdout, /then run the installer again/);
});

test("N1c-15: the install body exits 1 on a failed health check, and the banner sits behind that gate", () => {
  const s = src();
  const guardIdx = s.search(/^if ! verify_gateway; then$/m);
  assert.ok(guardIdx > -1, "the verification must be gated on verify_gateway");
  const guard = s.slice(guardIdx, s.indexOf("\nfi\n", guardIdx));
  assert.match(guard, /exit 1/, "a failed health check must end the install non-zero");
  const bannerIdx = s.indexOf('header "Installation Complete"');
  const readyIdx = s.indexOf('echo "  Crow is ready!"');
  assert.ok(guardIdx < bannerIdx, "the guard must sit above the banner header");
  assert.ok(guardIdx < readyIdx, "the guard must sit above the 'Crow is ready!' echo");
  // Belt and braces: any other `error` (a dead unit that still answers, say)
  // also blocks the banner — and that second gate is above it too.
  const gateIdx = s.search(/^if install_failed; then$/m);
  assert.ok(gateIdx > -1 && gateIdx < bannerIdx, "install_failed must gate the banner as well");
});
