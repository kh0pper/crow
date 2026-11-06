import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  // Same rail for the bubblewrap AppArmor step (audit N1b-2): it reads a kernel
  // switch, installs a package, writes under APPARMOR_DIR and loads through
  // CROW_SUDO, so a scratch root with shims is mandatory — a regression here
  // must never reach the real /proc, /etc/apparmor.d or /usr/share of the
  // machine running the suite.
  if (/install_bwrap_apparmor|stage_bwrap_profile|bwrap_profile_sane|bwrap_profile_exists|userns_restricted|apparmor_parser_bin/.test(snippet)) {
    for (const key of ["APPARMOR_DIR", "APPARMOR_EXTRA_DIR", "USERNS_SYSCTL_PATH", "CROW_APPARMOR_PARSER",
      "CROW_APPARMOR_PARSER_DIRS", "CROW_SUDO", "CROW_APT", "CROW_APT_GET", "CROW_DPKG_DEB"]) {
      if (!env[key]) throw new Error(`${key} is required to run the bubblewrap AppArmor step in a test`);
    }
  }
  // Same rail for the pinned ufw-docker step (audit K7): it downloads a script
  // and installs it as root into UFW_DOCKER_DEST, so a scratch destination plus
  // a curl shim and a sudo shim are mandatory — a regression there must never
  // reach the network or /usr/local/bin of the machine running the suite.
  if (/install_ufw_docker/.test(snippet)) {
    for (const key of ["UFW_DOCKER_DEST", "CROW_CURL", "CROW_SUDO", "UFW_DOCKER_SHA256"]) {
      if (!env[key]) throw new Error(`${key} is required to run the ufw-docker step in a test`);
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
  // ufw), so it belongs to the same "before anything listens" window. Its helper
  // (defined above the source-only seam) does the work; the call in the body has
  // to sit above every unit start.
  const dockerFixIdx = s.indexOf("\ninstall_ufw_docker\n");
  assert.ok(dockerFixIdx > s.indexOf("CROW_INSTALL_SOURCE_ONLY"), "the ufw-docker step must still be CALLED in the install body");
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
 *  script's own helper does, and it can never ask for a password), `sshd` is the
 *  CROW_SSHD seam and `systemctl` the CROW_SYSTEMCTL seam. Both seams point at
 *  the shims by absolute path and `ss` is shimmed too, so nothing here can reach
 *  the real sshd, systemd, socket table or /etc/ssh. */
function sshScratch({ sshdT = "", sshdFails = false, sockets = {}, ssRows = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-sshports-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  shim(bin, "sudo", 'exec "$@"');
  // `sshd -T`: exactly the effective config this test pretends to see, or a
  // clean failure (no binary / a config error) — the cue for the fallback.
  shim(bin, "sshd", sshdFails ? "exit 1" : `cat <<'SSHD'\n${sshdT}\nSSHD`);
  // The ss listener probe is gone. Where a test hands it rows they are the kind
  // the old probe read (an sshd row, or a session process holding a forwarded
  // port): the new code must ignore them, and a regression must never read the
  // real socket table.
  shim(bin, "ss", ssRows.length ? `cat <<'SS'\n${ssRows.join("\n")}\nSS` : "exit 1");
  const units = Object.keys(sockets).map(
    (unit) => `    *${unit}*)\n      cat <<'LISTEN'\n${sockets[unit].join("\n")}\nLISTEN\n      exit 0 ;;`,
  );
  shim(bin, "systemctl", `case "$*" in\n${units.join("\n")}\n    *) exit 1 ;;\nesac`);
  return {
    dir,
    bin,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      CROW_SSHD: join(bin, "sshd"),
      CROW_SYSTEMCTL: join(bin, "systemctl"),
    },
  };
}

/** An sshd_config fixture — the config-path seam means /etc/ssh is never read. */
function sshdConfigFixture(lines) {
  const dir = mkdtempSync(join(tmpdir(), "crow-sshconf-"));
  const p = join(dir, "sshd_config");
  writeFileSync(p, lines);
  return p;
}

test("N1c-15: when sshd -T cannot answer, ssh_ports falls back to the config-file Port lines", () => {
  // `sshd -T` fails here (no binary, or a config error): the world-readable
  // files must still answer, exactly as they did before the sshd -T probe existed.
  const scratch = sshScratch({ sshdFails: true });
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

test("N1c-15: ssh_ports takes sshd -T's effective Port — the drop-in host with no Port line", () => {
  // The socket-activated host (Ubuntu 22.10+) keeps its port in a ListenStream=
  // drop-in: `sshd -T` is the only probe that resolves that into a `port` line.
  // The session arrived on the same port, and it still comes out once.
  const scratch = sshScratch({ sshdT: "port 2222\nlistenaddress 0.0.0.0" });
  const cfg = sshdConfigFixture("#Port 22\nListenAddress 0.0.0.0\n");
  const r = runWithHelpers(`ssh_ports "${cfg}"`, {
    ...scratch.env,
    SSH_CONNECTION: "100.64.20.5 51234 100.64.20.9 2222",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["2222"]);
});

test("N1c-15: two probes agreeing on 22 stay 22 — never the glued 2222", () => {
  // The glue bug: command substitution stripped the trailing newline of the
  // first probe, so ss's `22` and SSH_CONNECTION's `22` became `2222`. The
  // firewall then opened a port nothing listens on and left 22 unopened. The ss
  // row is the one the old probe read; today's code never looks at it.
  const scratch = sshScratch({
    sshdT: "port 22\npermitrootlogin without-password",
    ssRows: ['LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=812,fd=3))'],
  });
  const cfg = sshdConfigFixture("#Port 22\n");
  const r = runWithHelpers(`ssh_ports "${cfg}"`, {
    ...scratch.env,
    SSH_CONNECTION: "100.64.20.5 51234 100.64.20.9 22",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["22"]);
  assert.doesNotMatch(r.stdout, /2222/);
});

test("N1c-15: ssh_ports takes a socket-activated ListenStream= port ([::]:2200)", () => {
  // ssh.socket's Listen value, as `systemctl show -p Listen --value` prints it.
  const scratch = sshScratch({
    sshdT: "port 22",
    sockets: { "ssh.socket": ["[::]:2200 (Stream)", "0.0.0.0:2200 (Stream)"] },
  });
  const cfg = sshdConfigFixture("#Port 22\n");
  const r = runWithHelpers(`ssh_ports "${cfg}"`, { ...scratch.env, SSH_CONNECTION: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["22", "2200"]);
});

test("N1c-15: a loopback-only socket listener is never an SSH candidate", () => {
  // 127.0.0.0/8 and [::1] are not a way back in for a remote operator, so a
  // firewall rule for one is pointless (and hides the real port's absence).
  for (const listen of ["127.0.0.1:2201 (Stream)", "[::1]:2201 (Stream)", "localhost:2201 (Stream)"]) {
    const scratch = sshScratch({ sshdFails: true, sockets: { "ssh.socket": [listen] } });
    const cfg = sshdConfigFixture("#Port 22\n");
    const r = runWithHelpers(`ssh_ports "${cfg}"`, { ...scratch.env, SSH_CONNECTION: "" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "", `${listen} must not become an SSH candidate`);
  }
  // A Datagram entry on the same unit is not SSH either.
  const dgram = sshScratch({ sshdFails: true, sockets: { "ssh.socket": ["[::]:2202 (Datagram)"] } });
  const rd = runWithHelpers(`ssh_ports "${sshdConfigFixture("")}"`, { ...dgram.env, SSH_CONNECTION: "" });
  assert.equal(rd.status, 0, rd.stderr);
  assert.equal(rd.stdout.trim(), "");
});

test("N1c-15: a padded port is normalised to decimal and de-duplicated (0022 is 22)", () => {
  // `$((10#0022))` is 22; a bare `$((0022))` would be octal (and `0029` an error).
  const cfg = sshdConfigFixture("Port 0022\n");
  // The effective config's `port 0022` and the live session's `22` are one port.
  const effective = sshScratch({ sshdT: "port 0022" });
  const a = runWithHelpers(`ssh_ports "${cfg}"`, {
    ...effective.env,
    SSH_CONNECTION: "100.64.20.5 51234 100.64.20.9 22",
  });
  assert.equal(a.status, 0, a.stderr);
  assert.deepEqual(a.stdout.trim().split("\n"), ["22"]);
  // …and the config-file fallback normalises too: it printed 0022 AND 22 before.
  const fallback = sshScratch({ sshdFails: true });
  const b = runWithHelpers(`ssh_ports "${cfg}"`, {
    ...fallback.env,
    SSH_CONNECTION: "100.64.20.5 51234 100.64.20.9 22",
  });
  assert.equal(b.status, 0, b.stderr);
  assert.deepEqual(b.stdout.trim().split("\n"), ["22"]);
});

test("N1c-15: no candidate comes from a session process or the socket table — the ss probe is gone", () => {
  // Round 2: `ss -ltnHp` + a `*sshd*` process match also caught sshd's own
  // per-session children, whose `ssh -R` forwards would then be opened. That is
  // what an sshd-session row below looks like: it must never reach the firewall.
  const scratch = sshScratch({
    sshdT: "port 22",
    ssRows: [
      'LISTEN 0 4096 127.0.0.1:8443 0.0.0.0:* users:(("sshd-session",pid=913,fd=7))',
    ],
  });
  const r = runWithHelpers(`ssh_ports "${sshdConfigFixture("#Port 22\n")}"`, {
    ...scratch.env,
    SSH_CONNECTION: "",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["22"], "a forwarded port is not an SSH port");
  // …and the probe itself is gone from the source, not merely unreachable.
  const s = src();
  assert.doesNotMatch(s, /ss -ltnHp/, "the ss listener probe must be gone");
  assert.doesNotMatch(s, /sshd_ss_ports/, "…and so must its helper");
  assert.doesNotMatch(s, /\*sshd\*/, "…and the process-name substring match that also took ssh -R forwards");
  assert.match(s, /sudo_cmd "\$CROW_SSHD" -T/, "the effective-config probe goes through the script's sudo seam");
  assert.match(s, /"\$CROW_SYSTEMCTL" show -p Listen --value/, "socket activation is read from systemd");
  assert.match(s, /SSH_CONNECTION/, "the live session stays a probe");
  assert.match(s, /^CROW_SSHD="\$\{CROW_SSHD:-sshd\}"$/m, "CROW_SSHD is a test seam");
  assert.match(s, /^CROW_SYSTEMCTL="\$\{CROW_SYSTEMCTL:-systemctl\}"$/m, "CROW_SYSTEMCTL is a test seam");
});

test("N1c-15: ssh_ports matches the Port keyword case-insensitively (sshd keywords are)", () => {
  const scratch = sshScratch({ sshdFails: true });
  const cfg = sshdConfigFixture("PORT 2200\nPubkeyAuthentication yes\n");
  const r = runWithHelpers(`ssh_ports "${cfg}"`, { ...scratch.env, SSH_CONNECTION: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["2200"]);
});

test("N1c-15: ssh_ports stops at the first Match line — a Port there is invalid for sshd", () => {
  const scratch = sshScratch({ sshdFails: true });
  const cfg = sshdConfigFixture("Port 2222\nMatch Address 100.64.20.0/24\n  Port 2299\n");
  const r = runWithHelpers(`ssh_ports "${cfg}"`, { ...scratch.env, SSH_CONNECTION: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["2222"]);
});

test("N1c-15: ssh_ports drops ports outside 1-65535 (ufw allow 99999/tcp would fail under set -e)", () => {
  const scratch = sshScratch({ sshdT: "port 99999\nport 0\nport 65536\nport 2222\nport 65535" });
  const cfg = sshdConfigFixture("Port 99999\nPort 0\nPort 65536\nPort 2222\nPORT 65535\n");
  const r = runWithHelpers(`ssh_ports "${cfg}"`, {
    ...scratch.env,
    SSH_CONNECTION: "100.64.20.5 51234 100.64.20.9 99999",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["2222", "65535"]);
});

test("N1c-15: ssh_ports prints each port once (SSH_CONNECTION, sshd -T and ssh.socket agree)", () => {
  const scratch = sshScratch({
    sshdT: "port 2222\nport 22",
    sockets: { "ssh.socket": ["[::]:2222 (Stream)"] },
  });
  const cfg = sshdConfigFixture("Port 2222\nPort 22\n");
  const r = runWithHelpers(`ssh_ports "${cfg}"`, {
    ...scratch.env,
    SSH_CONNECTION: "100.64.20.5 51234 100.64.20.9 2222",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["2222", "22"]);
});

test("N1c-15: the sshd -T probe uses the script's sudo helper, never a fresh prompt", () => {
  const s = src();
  assert.ok(s.includes('sudo_cmd "$CROW_SSHD" -T'), "sshd -T must go through sudo_cmd (the script's own seam)");
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

// ─── Audit N1b-2: bubblewrap + Ubuntu's own AppArmor userns profile ─────────
// Ubuntu 24.04+ ships kernel.apparmor_restrict_unprivileged_userns=1, so
// bubblewrap cannot make the user namespace the bot sandbox needs. The installer
// never lifts that restriction and writes no profile of its own: it copies the
// distro's `bwrap-userns-restrict` into place (bwrap may build its namespaces;
// everything bwrap starts is stacked into `unpriv_bwrap`, which has `audit deny
// capability`). It must NOT install apparmor-profiles — that drops 19 other
// profiles (samba, avahi, dnsmasq, ping, php-fpm, syslog…) into /etc/apparmor.d
// in enforce mode — so it downloads the .deb and extracts that one file.
// Everything below runs against a scratch apparmor.d, a fake kernel switch and
// shims, so a regression can never touch the suite machine's /proc,
// /etc/apparmor.d or the network.

/**
 * Ubuntu's own profile, as the apparmor-profiles package ships it: bwrap may
 * build its namespaces, and everything it starts is stacked into `unpriv_bwrap`
 * with `audit deny capability`. The installer must copy this file unchanged —
 * it never writes a profile of its own.
 */
const BWRAP_PROFILE_FIXTURE = `abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(attach_disconnected) {
  allow capability,
  allow userns,
  allow mount,
  allow pivot_root,
  allow pix /** -> &bwrap//&unpriv_bwrap,
}

profile unpriv_bwrap flags=(attach_disconnected) {
  audit deny capability,
  allow pix /** -> &unpriv_bwrap,
}
`;

/** A scratch root: apparmor.d, Ubuntu's extra-profiles dir, the kernel switch,
 *  parser/sudo/apt/apt-get/dpkg-deb shims and a private TMPDIR (so a leftover
 *  temp dir or temp file shows). `extraSource` is the file an operator may
 *  already have on disk; `packageSource` is what the fake .deb contains. */
function apparmorScratch({
  restricted = "1",
  parserOk = true,
  extraSource = BWRAP_PROFILE_FIXTURE,
  packageSource = BWRAP_PROFILE_FIXTURE,
  installOk = true,
  downloadOk = true,
  extractOk = true,
  dpkgKillsParent = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-bwrap-"));
  const apparmorDir = join(dir, "apparmor.d");
  mkdirSync(apparmorDir);
  const extraDir = join(dir, "extra-profiles");
  mkdirSync(extraDir);
  if (extraSource !== null) writeFileSync(join(extraDir, "bwrap-userns-restrict"), extraSource);
  const tmpDir = join(dir, "tmp");
  mkdirSync(tmpDir);
  const sysctl = join(dir, "apparmor_restrict_unprivileged_userns");
  if (restricted !== null) writeFileSync(sysctl, restricted + "\n");
  const parserLog = join(dir, "parser.log");
  const parserScript = `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(parserLog)}\n${parserOk ? "" : "exit 1\n"}`;
  const parser = join(dir, "apparmor_parser-shim");
  writeFileSync(parser, parserScript, { mode: 0o755 });
  // Stands in for /usr/sbin: this parser is NOT on PATH, only in here.
  const sbin = join(dir, "sbin");
  mkdirSync(sbin);
  writeFileSync(join(sbin, "crow-fixture-apparmor_parser"), parserScript, { mode: 0o755 });
  const emptySbin = join(dir, "empty-sbin");
  mkdirSync(emptySbin);
  const aptLog = join(dir, "apt.log");
  const apt = join(dir, "apt-shim");
  writeFileSync(apt, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(aptLog)}\n`, { mode: 0o755 });
  // `apt-get download` writes the .deb into the CWD and needs no root; the shim
  // logs the call AND the working directory so the test can prove both.
  const aptGetLog = join(dir, "apt-get.log");
  const aptGet = join(dir, "apt-get-shim");
  writeFileSync(aptGet, [
    "#!/bin/sh",
    `printf '%s in %s\\n' "$*" "$PWD" >> ${JSON.stringify(aptGetLog)}`,
    downloadOk ? "" : "exit 1",
    ': > "$PWD/apparmor-profiles_24.04_all.deb"',
    "",
  ].join("\n"), { mode: 0o755 });
  // dpkg-deb -x <deb> <dir>: lays out the one file the installer may take.
  const debFixture = join(dir, "deb-fixture");
  writeFileSync(debFixture, packageSource ?? "");
  const dpkgLog = join(dir, "dpkg-deb.log");
  const dpkgDeb = join(dir, "dpkg-deb-shim");
  writeFileSync(dpkgDeb, [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(dpkgLog)}`,
    extractOk ? "" : "exit 1",
    'mkdir -p "$3/usr/share/apparmor/extra-profiles"',
    packageSource === null ? "" : `cp ${JSON.stringify(debFixture)} "$3/usr/share/apparmor/extra-profiles/bwrap-userns-restrict"`,
    // The only signal this harness can deliver safely: the shim TERMs the
    // installer shell that is waiting for it (its own parent). Deliberately the
    // LAST thing it does — bash runs the trap as soon as the signal arrives, so
    // anything the fake unpack did afterwards would recreate the temp dir that
    // the trap just removed and make the assertion meaningless.
    dpkgKillsParent ? 'kill -TERM "$PPID"' : "",
    "",
  ].join("\n"), { mode: 0o755 });
  const installLog = join(dir, "install.log");
  const sudo = join(dir, "sudo-shim");
  writeFileSync(sudo, [
    "#!/bin/sh",
    `case "$1" in install) printf '%s\\n' "$*" >> ${JSON.stringify(installLog)} ;; esac`,
    installOk ? "" : 'case "$1" in install) exit 1 ;; esac',
    'exec "$@"',
    "",
  ].join("\n"), { mode: 0o755 });
  return {
    dir, apparmorDir, profile: join(apparmorDir, "bwrap-userns-restrict"),
    oldProfile: join(apparmorDir, "crow-bwrap"), disableLink: join(apparmorDir, "disable", "bwrap-userns-restrict"),
    extraDir, sourcePath: join(extraDir, "bwrap-userns-restrict"), sysctl, parser, parserLog,
    sbin, emptySbin, apt, aptLog, aptGet, aptGetLog, dpkgDeb, dpkgLog, installLog, sudo, tmpDir,
  };
}

function runApparmorStep(scratch, snippet = "install_bwrap_apparmor", env = {}) {
  return runWithHelpers(snippet, {
    APPARMOR_DIR: scratch.apparmorDir,
    APPARMOR_EXTRA_DIR: scratch.extraDir,
    USERNS_SYSCTL_PATH: scratch.sysctl,
    CROW_APPARMOR_PARSER: scratch.parser,
    CROW_APPARMOR_PARSER_DIRS: scratch.emptySbin,
    CROW_SUDO: scratch.sudo,
    CROW_APT: scratch.apt,
    CROW_APT_GET: scratch.aptGet,
    CROW_DPKG_DEB: scratch.dpkgDeb,
    TMPDIR: scratch.tmpDir,
    ...env,
  });
}

const parserCalls = (s) => (existsSync(s.parserLog)
  ? readFileSync(s.parserLog, "utf-8").trim().split("\n").filter(Boolean)
  : []);
const logLines = (path) => (existsSync(path)
  ? readFileSync(path, "utf-8").trim().split("\n").filter(Boolean)
  : []);
const aptCalls = (s) => logLines(s.aptLog);
const aptGetCalls = (s) => logLines(s.aptGetLog);
const dpkgCalls = (s) => logLines(s.dpkgLog);

test("N1b-2: downloads apparmor-profiles without installing it, and takes only the profile", () => {
  // Nothing pre-installed: the only way to get the file is the package itself.
  const s = apparmorScratch({ extraSource: null });
  const r = runApparmorStep(s);
  assert.equal(r.status, 0, r.stderr);
  // The blocker review 2 found: installing the package drops 19 enforcing
  // profiles (samba, avahi, dnsmasq, ping, php-fpm, syslog…) onto the machine.
  assert.deepEqual(aptCalls(s), [], "the package is never installed");
  const downloads = aptGetCalls(s);
  assert.equal(downloads.length, 1, "one download, as the invoking user (not through sudo)");
  const [what, ...where] = downloads[0].split(" in ");
  assert.equal(what, "download apparmor-profiles");
  const cwd = where.join(" in ");
  assert.ok(cwd.startsWith(s.tmpDir), `the download runs in a temp dir (${cwd})`);
  assert.equal(existsSync(cwd), false, "and that temp dir is removed afterwards");
  assert.equal(dpkgCalls(s).length, 1, "the .deb is unpacked with dpkg-deb -x");
  assert.match(dpkgCalls(s)[0], /^-x \S+\.deb \S+$/);
  // Byte for byte, the one file — nothing else out of the package.
  assert.equal(readFileSync(s.profile, "utf-8"), BWRAP_PROFILE_FIXTURE, "byte for byte");
  const installed = readFileSync(s.profile, "utf-8");
  assert.ok(installed.includes("audit deny capability"), "the capability denial survives the copy");
  assert.ok(installed.includes("&bwrap//&unpriv_bwrap"), "and the stacking rule does too");
  assert.equal(statSync(s.profile).mode & 0o777, 0o644, "installed with mode 644");
  assert.deepEqual(parserCalls(s), [`-r ${s.profile}`], "loaded with apparmor_parser -r");
  assert.match(r.stdout, /AppArmor rule installed/);
  assert.match(r.stdout, /every capability use denied/, "the message says what the profile really does: a child keeps its capability set, but every use is denied");
  assert.deepEqual(readdirSync(s.tmpDir), [], "no temp file or temp dir is left behind");
});

test("N1b-2: installs Ubuntu's own profile file unchanged and leaves the package alone", () => {
  const s = apparmorScratch();
  const r = runApparmorStep(s);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(aptCalls(s), [], "apparmor-profiles is never installed");
  assert.deepEqual(aptGetCalls(s), [], "and never downloaded when the file is already here");
  assert.equal(readFileSync(s.profile, "utf-8"), BWRAP_PROFILE_FIXTURE, "byte for byte");
  assert.equal(statSync(s.profile).mode & 0o777, 0o644, "installed with mode 644");
  assert.deepEqual(parserCalls(s), [`-r ${s.profile}`], "loaded with apparmor_parser -r");
  assert.match(r.stdout, /AppArmor rule installed/);
  assert.deepEqual(readdirSync(s.tmpDir), [], "no temp file is left behind");
});

test("N1b-2: no profile when the kernel does not restrict user namespaces (reads 0, or missing)", () => {
  for (const restricted of ["0", null]) {
    const s = apparmorScratch({ restricted });
    const r = runApparmorStep(s);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(s.profile), false, `nothing is written (restricted=${restricted})`);
    assert.deepEqual(parserCalls(s), [], "the parser never runs");
    assert.deepEqual(aptCalls(s), [], "and no package is installed");
    assert.deepEqual(aptGetCalls(s), [], "nor downloaded");
    assert.match(r.stdout, /No AppArmor rule needed/);
  }
});

test("N1b-2: an existing third-party bwrap profile is left alone; a comment about bwrap is not a profile", () => {
  const distro = apparmorScratch();
  writeFileSync(join(distro.apparmorDir, "bwrap"), "profile bwrap /usr/bin/bwrap flags=(attach_disconnected) {\n  allow userns,\n}\n");
  const r1 = runApparmorStep(distro);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(existsSync(distro.profile), false);
  assert.deepEqual(parserCalls(distro), []);
  assert.match(r1.stdout, /already exists — left as it is/);

  const other = apparmorScratch();
  writeFileSync(join(other.apparmorDir, "some-local-file"), "abi <abi/4.0>,\nprofile other /usr/bin/bwrap {\n}\n");
  assert.equal(runApparmorStep(other).status, 0);
  assert.equal(existsSync(other.profile), false, "a profile line for bwrap anywhere counts");
  assert.deepEqual(parserCalls(other), []);

  // A comment is not a profile: the step must still install Ubuntu's file.
  const commentOnly = apparmorScratch();
  writeFileSync(join(commentOnly.apparmorDir, "notes"),
    "# /usr/bin/bwrap is handled by the distro\n# profile other /usr/bin/bwrap {\n# }\n");
  const r3 = runApparmorStep(commentOnly);
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(readFileSync(commentOnly.profile, "utf-8"), BWRAP_PROFILE_FIXTURE,
    "a comment mentioning the path never counts as a profile");
});

test("N1b-2: a package that does not provide the file warns and writes nothing", () => {
  const s = apparmorScratch({ extraSource: null, packageSource: null });
  const r = runApparmorStep(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /did not provide .*bwrap-userns-restrict/, "the warning names the missing file");
  assert.match(r.stdout, /without the sandbox/);
  assert.equal(existsSync(s.profile), false, "no other profile is ever written");
  assert.deepEqual(parserCalls(s), [], "nothing is loaded");
  assert.deepEqual(aptCalls(s), [], "the package is not installed either");
  assert.deepEqual(readdirSync(s.tmpDir), [], "no temp file or temp dir is left behind");
});

test("N1b-2: a download failure warns, writes nothing and leaves no temp dir", () => {
  const s = apparmorScratch({ extraSource: null, downloadOk: false });
  const r = runApparmorStep(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Could not download apparmor-profiles/);
  assert.match(r.stdout, /without the sandbox/);
  assert.doesNotMatch(r.stdout, /✗/, "warn(), not error()");
  assert.equal(existsSync(s.profile), false);
  assert.deepEqual(parserCalls(s), [], "nothing is loaded");
  assert.deepEqual(dpkgCalls(s), [], "nothing is unpacked");
  assert.deepEqual(readdirSync(s.tmpDir), [], "the temp dir and temp file are removed");
});

test("N1b-2: an extract failure warns, writes nothing and leaves no temp dir", () => {
  const s = apparmorScratch({ extraSource: null, extractOk: false });
  const r = runApparmorStep(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Could not unpack apparmor-profiles/);
  assert.match(r.stdout, /without the sandbox/);
  assert.doesNotMatch(r.stdout, /✗/, "warn(), not error()");
  assert.equal(existsSync(s.profile), false);
  assert.deepEqual(parserCalls(s), [], "nothing is loaded");
  assert.deepEqual(aptCalls(s), [], "the package is still not installed");
  assert.deepEqual(readdirSync(s.tmpDir), [], "the temp dir and temp file are removed");
});

test("N1b-2: a source that is not the expected profile is refused", () => {
  // A future apparmor-profiles could change shape. Both of these would lift (or
  // fail to keep) Ubuntu's restriction, so neither may be installed.
  const cases = {
    "no unpriv_bwrap child": BWRAP_PROFILE_FIXTURE.replace("profile unpriv_bwrap", "profile other_bwrap"),
    "flags=(unconfined)": BWRAP_PROFILE_FIXTURE.replace(
      "profile bwrap /usr/bin/bwrap flags=(attach_disconnected)",
      "profile bwrap /usr/bin/bwrap flags=(unconfined)"),
    "no capability denial": BWRAP_PROFILE_FIXTURE.replace("audit deny capability", "allow capability"),
  };
  for (const [label, source] of Object.entries(cases)) {
    assert.notEqual(source, BWRAP_PROFILE_FIXTURE, `the fixture really changed (${label})`);
    // Both the on-disk copy and the downloaded package are checked.
    for (const opts of [{ extraSource: source }, { extraSource: null, packageSource: source }]) {
      const s = apparmorScratch(opts);
      const r = runApparmorStep(s);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(existsSync(s.profile), false, `nothing is written (${label})`);
      assert.deepEqual(parserCalls(s), [], `nothing is loaded (${label})`);
      assert.deepEqual(aptCalls(s), [], `the package is never installed (${label})`);
      assert.match(r.stdout, /does not have the expected shape/, `the warning says why (${label})`);
      assert.match(r.stdout, /without the sandbox/);
      assert.deepEqual(readdirSync(s.tmpDir), [], `no temp file or temp dir is left behind (${label})`);
    }
  }
});

test("N1b-2: a source without the '-> &bwrap//&unpriv_bwrap' stacking rule is refused", () => {
  // The child profile can exist and still be useless: unless bwrap's children
  // are moved into it with the stacking rule, nothing bwrap runs is under
  // `audit deny capability`. Must be refused, not installed.
  const noStack = BWRAP_PROFILE_FIXTURE.replace("  allow pix /** -> &bwrap//&unpriv_bwrap,\n", "");
  assert.notEqual(noStack, BWRAP_PROFILE_FIXTURE, "the fixture really changed");
  assert.ok(!noStack.includes("&bwrap//&unpriv_bwrap"), "the stacking rule is gone");
  for (const opts of [{ extraSource: noStack }, { extraSource: null, packageSource: noStack }]) {
    const s = apparmorScratch(opts);
    const r = runApparmorStep(s);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(s.profile), false, "nothing is written");
    assert.deepEqual(parserCalls(s), [], "nothing is loaded");
    assert.deepEqual(aptCalls(s), [], "the package is never installed");
    assert.match(r.stdout, /does not have the expected shape/, "the warning says why");
    assert.match(r.stdout, /without the sandbox/);
    assert.deepEqual(readdirSync(s.tmpDir), [], "no temp file or temp dir is left behind");
  }
  // Ubuntu's own file, which does carry the rule, still installs unchanged.
  const ok = apparmorScratch();
  assert.equal(runApparmorStep(ok).status, 0);
  assert.equal(readFileSync(ok.profile, "utf-8"), BWRAP_PROFILE_FIXTURE, "byte for byte");
});

test("N1b-2: a source with flags=(attach_disconnected,unconfined) is refused", () => {
  // `unconfined` does not have to be the only entry in the list to lift the
  // restriction, so an exact-string check on `flags=(unconfined)` is not enough.
  const source = BWRAP_PROFILE_FIXTURE.replace(
    "profile bwrap /usr/bin/bwrap flags=(attach_disconnected)",
    "profile bwrap /usr/bin/bwrap flags=(attach_disconnected,unconfined)");
  assert.notEqual(source, BWRAP_PROFILE_FIXTURE, "the fixture really changed");
  for (const opts of [{ extraSource: source }, { extraSource: null, packageSource: source }]) {
    const s = apparmorScratch(opts);
    const r = runApparmorStep(s);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(s.profile), false, "nothing is written");
    assert.deepEqual(parserCalls(s), [], "nothing is loaded");
    assert.deepEqual(aptCalls(s), [], "the package is never installed");
    assert.match(r.stdout, /does not have the expected shape/, "the warning says why");
    assert.match(r.stdout, /without the sandbox/);
    assert.deepEqual(readdirSync(s.tmpDir), [], "no temp file or temp dir is left behind");
  }
});

test("N1b-2: a source with flags=(complain) is refused", () => {
  // A complaining profile enforces nothing at all: it must be refused too, not
  // treated as equivalent to the enforcing attach_disconnected list.
  const source = BWRAP_PROFILE_FIXTURE.replace(
    "profile bwrap /usr/bin/bwrap flags=(attach_disconnected)",
    "profile bwrap /usr/bin/bwrap flags=(complain)");
  assert.notEqual(source, BWRAP_PROFILE_FIXTURE, "the fixture really changed");
  assert.ok(source.includes("flags=(complain)"), "the flag is in the source");
  for (const opts of [{ extraSource: source }, { extraSource: null, packageSource: source }]) {
    const s = apparmorScratch(opts);
    const r = runApparmorStep(s);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(s.profile), false, "nothing is written");
    assert.deepEqual(parserCalls(s), [], "nothing is loaded");
    assert.deepEqual(aptCalls(s), [], "the package is never installed");
    assert.match(r.stdout, /does not have the expected shape/, "the warning says why");
    assert.match(r.stdout, /without the sandbox/);
    assert.deepEqual(readdirSync(s.tmpDir), [], "no temp file or temp dir is left behind");
  }
});

test("N1b-2: our own earlier crow-bwrap profile is removed and unloaded before the new one", () => {
  const s = apparmorScratch();
  writeFileSync(s.oldProfile, "abi <abi/4.0>,\nprofile crow-bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n");
  const r = runApparmorStep(s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(s.oldProfile), false, "the too-wide file is gone");
  assert.deepEqual(parserCalls(s), [`-R ${s.oldProfile}`, `-r ${s.profile}`],
    "unloaded by name first, then Ubuntu's profile is loaded");
  assert.equal(readFileSync(s.profile, "utf-8"), BWRAP_PROFILE_FIXTURE);
  assert.match(r.stdout, /Removed the earlier crow-bwrap/);
});

test("N1b-2: our own earlier crow-bwrap profile is removed even when the rule is not needed", () => {
  // Should-fix 2 from review 2: the unsafe profile must not survive a run that
  // then decides it has nothing to do (switch reads 0, or parser missing).
  for (const restricted of ["0", null]) {
    const s = apparmorScratch({ restricted });
    writeFileSync(s.oldProfile, "abi <abi/4.0>,\nprofile crow-bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n");
    const r = runApparmorStep(s);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(s.oldProfile), false, `the too-wide file is gone (restricted=${restricted})`);
    assert.deepEqual(parserCalls(s), [`-R ${s.oldProfile}`], "unloaded by name");
    assert.match(r.stdout, /Removed the earlier crow-bwrap/);
    assert.match(r.stdout, /No AppArmor rule needed/);
    assert.equal(existsSync(s.profile), false, "no new profile is written");
  }

  // Same when no parser can be found: the file still goes.
  const noParser = apparmorScratch();
  writeFileSync(noParser.oldProfile, "profile crow-bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n");
  const r2 = runApparmorStep(noParser, "install_bwrap_apparmor", {
    CROW_APPARMOR_PARSER: "crow-fixture-no-such-parser",
    CROW_APPARMOR_PARSER_DIRS: noParser.emptySbin,
  });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(existsSync(noParser.oldProfile), false, "removed without a parser too");
  assert.deepEqual(parserCalls(noParser), [], "nothing could be unloaded");
  assert.match(r2.stdout, /apparmor_parser is not available/);
});

test("N1b-2: a disable link is reported, never removed", () => {
  const s = apparmorScratch();
  mkdirSync(join(s.apparmorDir, "disable"));
  writeFileSync(s.disableLink, "");
  const r = runApparmorStep(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /disable\/bwrap-userns-restrict is present/);
  assert.match(r.stdout, /disables the bubblewrap profile at boot/);
  assert.equal(existsSync(s.disableLink), true, "the operator's choice is left in place");
  // The rule still goes in: it applies now, the warning covers the next reboot.
  assert.equal(readFileSync(s.profile, "utf-8"), BWRAP_PROFILE_FIXTURE);
  assert.deepEqual(parserCalls(s), [`-r ${s.profile}`]);
});

test("N1b-2: an install failure warns and continues, leaving no temp file", () => {
  const s = apparmorScratch({ installOk: false });
  const r = runApparmorStep(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Could not install the AppArmor profile/);
  assert.match(r.stdout, /without the sandbox/);
  assert.doesNotMatch(r.stdout, /✗/, "warn(), not error()");
  assert.equal(existsSync(s.profile), false);
  assert.deepEqual(parserCalls(s), [], "a half-installed profile is never loaded");
  assert.deepEqual(readdirSync(s.tmpDir), [], "the temp copy is removed");
});

test("N1b-2: a failed load puts the previous copy back", () => {
  const previous = "# distro profile installed earlier\nabi <abi/4.0>,\nprofile bwrap /usr/bin/bwrap flags=(attach_disconnected) {\n  allow userns,\n}\n";
  const s = apparmorScratch({ parserOk: false });
  writeFileSync(s.profile, previous);
  const r = runApparmorStep(s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(s.profile, "utf-8"), previous, "the previous file is back in place");
  assert.deepEqual(parserCalls(s), [`-r ${s.profile}`], "the new profile really was attempted");
  assert.match(r.stdout, /previous one is back in place/);
  assert.deepEqual(readdirSync(s.tmpDir), [], "no temp file is left behind");
});

test("N1b-2: a failed load with no previous copy leaves nothing behind", () => {
  const s = apparmorScratch({ parserOk: false });
  const r = runApparmorStep(s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(s.profile), false, "no broken profile stays behind");
  assert.deepEqual(parserCalls(s), [`-r ${s.profile}`, `-R ${s.profile}`],
    "the load was attempted, then unloaded by name");
  assert.match(r.stdout, /Could not load the AppArmor profile/);
  assert.match(r.stdout, /without the sandbox/, "the warning says what the operator loses");
  assert.doesNotMatch(r.stdout, /✗/, "warn(), not error()");
  assert.deepEqual(readdirSync(s.tmpDir), [], "no temp file is left behind");
});

test("N1b-2: idempotent — identical content means no rewrite and no reload", () => {
  const s = apparmorScratch();
  assert.equal(runApparmorStep(s).status, 0);
  assert.equal(readFileSync(s.profile, "utf-8"), BWRAP_PROFILE_FIXTURE, "Ubuntu's file, not one of ours");
  const before = statSync(s.profile);
  const second = runApparmorStep(s);
  assert.equal(second.status, 0, second.stderr);
  const after = statSync(s.profile);
  assert.equal(after.ino, before.ino, "the file is not rewritten");
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(parserCalls(s).length, 1, "the second run must not reload the profile");
  assert.match(second.stdout, /unchanged/);
});

test("N1b-2: the step can only run in tests with the scratch seams set", () => {
  assert.throws(
    () => runWithHelpers("install_bwrap_apparmor"),
    /APPARMOR_DIR is required/,
  );
  // Every seam the step touches is mandatory: a partial set would reach the
  // suite machine's real apt, /usr/share/apparmor or /usr/sbin.
  assert.throws(
    () => runWithHelpers("install_bwrap_apparmor", { APPARMOR_DIR: "/tmp/__crow_bwrap_never__" }),
    /APPARMOR_EXTRA_DIR is required/,
  );
  assert.throws(
    () => runWithHelpers("apparmor_parser_bin", {
      APPARMOR_DIR: "/tmp/__crow_bwrap_never__", APPARMOR_EXTRA_DIR: "/tmp/__crow_bwrap_never__",
      USERNS_SYSCTL_PATH: "/tmp/__crow_bwrap_never__", CROW_APPARMOR_PARSER: "apparmor_parser",
    }),
    /CROW_APPARMOR_PARSER_DIRS is required/,
  );
});

test("N1b-2: the parser is found in the sbin dirs when it is not on PATH", () => {
  const s = apparmorScratch();
  const r = runApparmorStep(s, "install_bwrap_apparmor", {
    CROW_APPARMOR_PARSER: "crow-fixture-apparmor_parser",
    CROW_APPARMOR_PARSER_DIRS: s.sbin,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(s.profile, "utf-8"), BWRAP_PROFILE_FIXTURE, "the profile is installed");
  assert.deepEqual(parserCalls(s), [`-r ${s.profile}`], "and loaded through the parser found there");
  assert.match(r.stdout, /AppArmor rule installed/);
});

test("N1b-2: the installer never writes a kernel setting, and never writes a profile of its own", () => {
  const s = src();
  assert.doesNotMatch(s, /\bsysctl\b/, "no sysctl invocation anywhere in the installer");
  assert.doesNotMatch(s, /apparmor_restrict_unprivileged_userns\s*=\s*0/, "the restriction is never set to 0");
  assert.doesNotMatch(s, /apparmor_restrict_unprivileged_userns"?\s*>\s*\S/, "the proc file is only ever read");
  // Review 1's blocker: an unconfined profile would let anyone who can run bwrap
  // lift Ubuntu's restriction for the whole host, which is exactly what upstream
  // and Ubuntu's own bwrap-userns-restrict profile avoid. The installer may only
  // GREP for that flag (it refuses such a source); it must never write one.
  assert.doesNotMatch(s, /^\s*profile\s+\S+[^\n]*flags=\(unconfined\)/m, "no profile with flags=(unconfined) may be written");
  // The shape check refuses the whole family: either word anywhere in a flags
  // list (an exact-string check would miss `flags=(attach_disconnected,unconfined)`),
  // and it also demands the stacking rule that puts bwrap's children under the denial.
  // The two shape checks themselves are asserted with includes() in
  // "the shape check refuses a flags list carrying unconfined or complain" below
  // (their shell text carries backslashes that are unreadable as JS regexes).
  // The earlier escaped-regex form, kept for reference:
  // assert.match(s, /grep -Eq 'flags=\\\(\[^\)\]\*\(unconfined\|complain\)'/, "a source carrying either word in a flags list is refused instead");
  // assert.match(s, /grep -qF '-> &bwrap\/\/&unpriv_bwrap'/, "and a source without the stacking rule is refused too");
  assert.doesNotMatch(s, /^\s*profile\s+\S+\s+\/usr\/bin\/bwrap/m, "the installer writes no profile at all");
  // It copies the distro's own file instead.
  assert.match(s, /APPARMOR_EXTRA_DIR:-\/usr\/share\/apparmor\/extra-profiles/);
});

test("N1b-2: the installer never installs apparmor-profiles — it downloads and extracts it", () => {
  // Review 2's blocker: installing the package adds 19 other profiles (samba,
  // avahi, dnsmasq, nscd, ping, traceroute, php-fpm, syslog…) in enforce mode.
  const s = src();
  assert.doesNotMatch(s, /^\s*apt_install\b[^\n]*apparmor-profiles/m, "no apt_install of the package");
  assert.doesNotMatch(s, /apt(-get)?\s+install[^\n]*apparmor-profiles/, "no `apt install apparmor-profiles` either");
  assert.doesNotMatch(s, /^\s*sudo[^\n]*apparmor-profiles/m, "never with sudo, it needs no root");
  // The one file is taken out of the .deb in a temp dir instead.
  assert.match(s, /CROW_APT_GET="\$\{CROW_APT_GET:-apt-get\}"/);
  assert.match(s, /CROW_DPKG_DEB="\$\{CROW_DPKG_DEB:-dpkg-deb\}"/);
  assert.match(s, /\$CROW_APT_GET download apparmor-profiles/);
  assert.match(s, /"\$CROW_DPKG_DEB" -x "\$deb" "\$tmpdir\/x"/);
  assert.match(s, /tmpdir\/x\/usr\/share\/apparmor\/extra-profiles\/bwrap-userns-restrict/);
  // And the temp dir is removed on every path out of the fetch.
  const fetch = s.slice(s.indexOf("stage_bwrap_profile() {"), s.indexOf("bwrap_profile_sane() {"));
  assert.match(fetch, /rm -rf "\$tmpdir"/, "the temp dir is removed, not left behind");
});

test("N1b-2: bubblewrap is installed from apt before the auto-update timer turns on, and the rule is applied from the install body", () => {
  const s = src();
  const line = s.match(/^sudo apt install -y bubblewrap$/m);
  assert.ok(line, "an apt install line for bubblewrap must exist");
  const idx = s.indexOf(line[0]);
  assert.ok(idx < s.indexOf('header "Step 5/10: Automatic Security Updates"'),
    "before the timer that can hold the dpkg lock (so no lock timeout is needed)");
  assert.ok(idx > s.indexOf('header "Step 2/10: Node.js'), "in the Node variable step, before any use of a bot");
  assert.ok(idx < s.search(/header "Step \d+\/10: System Services"/), "before the gateway starts");
  // Defined above the source-only seam (so tests can drive it) and CALLED below it.
  const seamIdx = s.indexOf("CROW_INSTALL_SOURCE_ONLY");
  assert.ok(s.indexOf("install_bwrap_apparmor()") > -1 && s.indexOf("install_bwrap_apparmor()") < seamIdx);
  const callIdx = s.indexOf("\ninstall_bwrap_apparmor\n");
  assert.ok(callIdx > seamIdx, "the install body really calls it");
  assert.ok(callIdx < s.search(/header "Step \d+\/10: System Services"/), "and does so before the gateway starts");
  // Ubuntu's profile package is fetched by the same step, before the timer. A
  // plain `apt-get download` needs no dpkg lock, so no lock timeout is needed
  // either — and the package is never installed (see the static test above).
  const download = s.indexOf("$CROW_APT_GET download apparmor-profiles");
  assert.ok(download > s.indexOf("stage_bwrap_profile()"), "the step fetches the package itself");
  assert.ok(download < s.indexOf('header "Step 5/10: Automatic Security Updates"'),
    "…and that runs before the auto-update timer can hold the dpkg lock");
});

test("N1b-2: the shape check refuses a flags list carrying unconfined or complain, and a missing stacking rule", () => {
  const s = src();
  // Asserted against the shape check itself, so a later edit to that function
  // cannot quietly drop one of the two requirements it gained.
  const shape = s.slice(s.indexOf("bwrap_profile_sane() {"), s.indexOf("install_bwrap_apparmor() {"));
  assert.ok(shape.includes("grep -Eq 'flags="), "the flags list is checked with a pattern, not an exact string");
  assert.ok(shape.includes("(unconfined|complain)"), "…and either word, anywhere in the list, is refused");
  assert.ok(shape.includes("grep -Eq -- '-> &?bwrap//&unpriv_bwrap'"),
    "the stacking rule is required (both spellings), and its leading '-' needs the '--' terminator");
});

test("N1b-2: Ubuntu 24.04's own spelling of the stacking rule is accepted", () => {
  // apparmor-profiles 4.0.1 on 24.04 writes `allow px /** -> bwrap//&unpriv_bwrap,`
  // (px, no leading &); upstream writes `allow pix /** -> &bwrap//&unpriv_bwrap,`.
  // A check that knew only the upstream spelling would refuse the real 24.04 file.
  const ubuntu = BWRAP_PROFILE_FIXTURE.replace("  allow pix /** -> &bwrap//&unpriv_bwrap,\n", "  allow px /** -> bwrap//&unpriv_bwrap,\n");
  assert.notEqual(ubuntu, BWRAP_PROFILE_FIXTURE, "the fixture really changed");
  const s = apparmorScratch({ extraSource: ubuntu });
  const r = runApparmorStep(s);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(s.profile), "the 24.04 spelling is installed");
  assert.equal(readFileSync(s.profile, "utf8"), ubuntu, "byte for byte");
});

// ─── Lane A's Ubuntu 24.04 follow-ups ───────────────────────────────────────
// Two things the VM runs turned up. (1) Every re-run downloaded
// apparmor-profiles again, so an offline re-run warned "Could not download" for
// a file that was already correct on disk. (2) The fetch's temp dir was only
// removed on the explicit `rm -rf` lines, so an interrupt (Ctrl-C, SIGTERM)
// during the download or the extract left the .deb tree in $TMPDIR.

test("follow-up 1: a re-run with a sane installed profile never downloads — it logs 'already in place'", () => {
  // Lane A's case: the profile is installed, this host has no extra-profiles
  // copy, and there is no network. Before the fast path, stage_bwrap_profile
  // still ran `apt-get download apparmor-profiles` here, which fails offline and
  // warns for nothing. Now the shim is never called at all.
  const s = apparmorScratch({ extraSource: null });
  writeFileSync(s.profile, BWRAP_PROFILE_FIXTURE);
  const before = statSync(s.profile);
  const r = runApparmorStep(s);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(aptGetCalls(s), [], "no download for a host that is already set up");
  assert.deepEqual(dpkgCalls(s), [], "and nothing is extracted either");
  assert.match(r.stdout, /AppArmor rule for bubblewrap already in place/);
  const after = statSync(s.profile);
  assert.equal(after.ino, before.ino, "the installed copy is not rewritten");
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(readFileSync(s.profile, "utf-8"), BWRAP_PROFILE_FIXTURE);
  // It was loaded when it was installed (or AppArmor loads it at boot), so the
  // fast path must not reload it.
  assert.deepEqual(parserCalls(s), [], "never reloaded on a re-run");
});

test("follow-up 1: a re-run whose installed copy fails the shape check goes through the download path", () => {
  // The one case the fast path must NOT take: the file on disk is not the
  // profile we expect (here its flags list would lift Ubuntu's restriction), so
  // it is fetched and replaced exactly as before.
  const insane = BWRAP_PROFILE_FIXTURE.replace(
    "profile bwrap /usr/bin/bwrap flags=(attach_disconnected)",
    "profile bwrap /usr/bin/bwrap flags=(unconfined)");
  assert.notEqual(insane, BWRAP_PROFILE_FIXTURE, "the installed fixture really changed");
  const s = apparmorScratch({ extraSource: null });
  writeFileSync(s.profile, insane);
  const r = runApparmorStep(s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(aptGetCalls(s).length, 1, "the package is downloaded again");
  assert.equal(dpkgCalls(s).length, 1, "and unpacked again");
  assert.equal(readFileSync(s.profile, "utf-8"), BWRAP_PROFILE_FIXTURE, "the sane copy replaces it");
  assert.deepEqual(parserCalls(s), [`-r ${s.profile}`], "and is loaded");
  assert.match(r.stdout, /AppArmor rule installed/);
});

test("follow-up 1: a differing copy in APPARMOR_EXTRA_DIR is copied over, with no download", () => {
  // The operator's own apparmor-profiles was updated: the extra-profiles copy is
  // sane but differs from what is installed. The fast path must not swallow that
  // — the installed copy is refreshed through the existing copy path, and no
  // download is involved (which is the point: it works offline too).
  const older = BWRAP_PROFILE_FIXTURE.replace(
    "  allow pix /** -> &bwrap//&unpriv_bwrap,\n",
    "  allow px /** -> bwrap//&unpriv_bwrap,\n"); // 24.04's spelling: sane, different bytes
  assert.notEqual(older, BWRAP_PROFILE_FIXTURE, "the installed fixture really changed");
  const s = apparmorScratch();
  writeFileSync(s.profile, older);
  const r = runApparmorStep(s);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(aptGetCalls(s), [], "the host's own copy is used, never a download");
  assert.equal(readFileSync(s.profile, "utf-8"), BWRAP_PROFILE_FIXTURE, "refreshed to the newer copy");
  assert.deepEqual(parserCalls(s), [`-r ${s.profile}`], "the new bytes are loaded");
  assert.match(r.stdout, /AppArmor rule installed/);
});

test("follow-up 2: an interrupt during the extract removes the temp dir (INT/TERM/EXIT trap)", () => {
  // Before the trap the only removal was the explicit `rm -rf` on each path, so
  // a signal arriving while dpkg-deb was unpacking left the whole tree in
  // $TMPDIR. The dpkg-deb shim TERMs the installer shell itself (its parent) —
  // the one signal this harness can deliver safely — and the trap must remove
  // the dir before the shell goes, with the .deb already inside it.
  const s = apparmorScratch({ extraSource: null, dpkgKillsParent: true });
  const r = runApparmorStep(s);
  assert.equal(r.status, 143, `the TERM handler exits 143 (stderr: ${r.stderr})`);
  // The temp DIR is what the interrupt must not leave behind: the downloaded
  // .deb and the tree dpkg-deb was unpacking. install_bwrap_apparmor's own small
  // staging FILE (a `mktemp` in $TMPDIR) may survive — the signal exits the
  // shell from inside the fetch, exactly as a real Ctrl-C would, so that
  // function never reaches its `rm -f`; the trap this task asks for is the one
  // around the temp dir.
  const dirs = readdirSync(s.tmpDir).filter((n) => statSync(join(s.tmpDir, n)).isDirectory());
  assert.deepEqual(dirs, [], "the mktemp -d tree (the .deb and the extracted package) is gone");
  // Nothing was installed from a half-unpacked package.
  assert.equal(existsSync(s.profile), false);
  assert.deepEqual(parserCalls(s), []);
});

test("follow-up 2: an EXIT trap installed before the fetch is still set (and still runs) after it returns", () => {
  // Bash has no function-local traps, so the step's cleanup traps are
  // process-wide for as long as it runs: the caller's must be put back before
  // every return. Both halves are asserted — the outer trap is queryable again
  // after the function returned, and it still runs when the shell exits.
  const s = apparmorScratch({ extraSource: null });
  const r = runApparmorStep(s,
    `trap 'echo OUTER_EXIT_RAN' EXIT; stage_bwrap_profile "$APPARMOR_DIR/probe-profile"; trap -p EXIT`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /trap -- 'echo OUTER_EXIT_RAN' EXIT/, "the outer EXIT trap is back in place");
  assert.match(r.stdout, /OUTER_EXIT_RAN/, "and it still runs at shell exit");
  assert.equal(readFileSync(join(s.apparmorDir, "probe-profile"), "utf-8"), BWRAP_PROFILE_FIXTURE,
    "the fetch itself did its job");
  assert.deepEqual(readdirSync(s.tmpDir), [], "the temp dir is removed on the normal path too");
});

test("follow-up 2: the fetch sets its cleanup traps right after mktemp -d and restores them on every exit", () => {
  // The static half of the trap contract (the dynamic test above can only deliver
  // TERM): the traps go in immediately after the temp dir exists, and every
  // `rm -rf "$tmpdir"` is followed by the restore — so no path returns with the
  // step's handlers still installed.
  const fn = src().slice(src().indexOf("stage_bwrap_profile() {"), src().indexOf("# bwrap_profile_sane"));
  const mktempIdx = fn.indexOf("mktemp -d");
  const trapIdx = fn.indexOf('trap "stage_trap_cleanup');
  assert.ok(mktempIdx > -1 && trapIdx > mktempIdx, "the trap is installed right after mktemp -d");
  for (const sig of ["INT", "TERM", "EXIT"]) {
    assert.match(fn.slice(trapIdx), new RegExp(`trap \\"stage_trap_cleanup [^\\n]*\\" ${sig}$`, "m"),
      `a cleanup trap is installed for ${sig}`);
  }
  // `rm -rf "$tmpdir"` appears at two indentation levels (inside an `if` and at
  // the end of the function), so match any leading whitespace.
  const removals = (fn.match(/^\s*rm -rf "\$tmpdir"$/gm) || []).length;
  const restores = (fn.match(/^\s*stage_trap_restore /gm) || []).length;
  assert.ok(removals >= 6, `expected every exit path of the fetch, found ${removals} removals`);
  assert.equal(restores, removals, "every path removes the dir and then restores the caller's traps");
});

// ─── Security audit K7 (part): ufw-docker is pinned, never fetched from master ─
// The step used to `sudo curl …/chaifeng/ufw-docker/raw/master/ufw-docker -o
// /usr/local/bin/ufw-docker` and then run it as root: whatever that moving
// branch held at that second was what ran on the operator's machine. It is now
// pinned to one commit and one sha256, downloaded by the invoking user into a
// temp file, verified, and only then installed. Everything below points
// CROW_CURL, CROW_SUDO and UFW_DOCKER_DEST at a scratch dir, so no test can
// download anything, run anything as root, or touch /usr/local/bin.

const sha256Hex = (body) => createHash("sha256").update(body).digest("hex");

/** A scratch dir holding: a curl shim that "serves" a fixture body (no
 *  network), a sudo shim that runs its argument, a private TMPDIR (so a
 *  leftover temp file shows) and a UFW_DOCKER_DEST inside the scratch dir.
 *  `pinBody` is what the test declares as the pinned checksum, `body` is what
 *  the "network" actually delivers, so a mismatch is expressible. */
function ufwDockerScratch({ body = null, pinBody = null, existing = null, downloadOk = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-ufwdocker-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const tmpDir = join(dir, "tmp");
  mkdirSync(tmpDir);
  const dest = join(dir, "usr-local-bin", "ufw-docker");
  mkdirSync(join(dir, "usr-local-bin"));
  if (existing !== null) writeFileSync(dest, existing, { mode: 0o755 });

  const fixtureLog = join(dir, "fixture.log");
  const fixtureBody = [
    "#!/bin/sh",
    "# fixture standing in for chaifeng/ufw-docker (never the real file)",
    `printf '%s\\n' "$*" >> ${JSON.stringify(fixtureLog)}`,
    "exit 0",
    "",
  ].join("\n");
  const downloaded = body ?? fixtureBody;
  // What the shimmed `curl` serves: a file on disk it copies to curl's -o target.
  const served = join(dir, "served");
  writeFileSync(served, downloaded);

  const curlLog = join(dir, "curl.log");
  const curl = shim(bin, "curl", [
    `printf '%s\\n' "$*" >> ${JSON.stringify(curlLog)}`,
    ...(downloadOk ? [] : ["exit 22"]),
    'out=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -o) out="$2"; shift 2 ;;',
    "    *) shift ;;",
    "  esac",
    "done",
    '[ -n "$out" ] || exit 2',
    `cp ${JSON.stringify(served)} "$out"`,
  ].join("\n"));

  const sudoLog = join(dir, "sudo.log");
  const sudo = shim(bin, "sudo", [
    `printf '%s\\n' "$*" >> ${JSON.stringify(sudoLog)}`,
    'exec "$@"',
  ].join("\n"));
  // `sudo_cmd ufw reload` needs a ufw to run once the sudo shim has exec'd it;
  // it only has to succeed. Its own calls are read from the sudo log above.
  shim(bin, "ufw", "exit 0");

  return {
    dir, bin, tmpDir, dest, served, fixtureLog, curlLog, sudoLog, curl, sudo,
    env: {
      UFW_DOCKER_DEST: dest,
      CROW_CURL: curl,
      CROW_SUDO: sudo,
      UFW_DOCKER_SHA256: sha256Hex(pinBody ?? downloaded),
      TMPDIR: tmpDir,
      PATH: `${bin}:${process.env.PATH}`,
    },
  };
}

function runUfwDocker(scratch, snippet = "install_ufw_docker", env = {}) {
  return runWithHelpers(snippet, { ...scratch.env, ...env });
}

test("K7: a matching download is verified in a temp file, then installed and wired into ufw", () => {
  const s = ufwDockerScratch();
  const r = runUfwDocker(s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // Byte for byte the verified bytes, mode 755, at the scratch destination.
  assert.equal(readFileSync(s.dest, "utf-8"), readFileSync(s.served, "utf-8"));
  assert.equal(statSync(s.dest).mode & 0o777, 0o755, "installed with mode 755");
  // The download went to the PINNED commit URL, into a temp file.
  const curlCalls = logLines(s.curlLog);
  assert.equal(curlCalls.length, 1, "one download");
  assert.match(curlCalls[0], /-fsSL/);
  assert.match(curlCalls[0], /raw\.githubusercontent\.com\/chaifeng\/ufw-docker\/020a8699f95592561f254d8d4ad1bb40d401dfc7\/ufw-docker/);
  assert.ok(curlCalls[0].includes(s.tmpDir), `the -o target is a temp file, not /usr/local/bin (${curlCalls[0]})`);
  // The FRESH install path's whole privileged sequence, in order: the file goes
  // in with `install -T` (so a destination that is not a file can never be
  // filled), the installed file wires the rules, and ufw is reloaded last —
  // ufw was enabled above, before after.rules was rewritten, so without the
  // reload a published container port keeps bypassing the firewall.
  const sudoCalls = logLines(s.sudoLog);
  assert.equal(sudoCalls.length, 3, `expected exactly three privileged calls, got ${JSON.stringify(sudoCalls)}`);
  assert.match(sudoCalls[0], /^install -T -m 755 \S+ \S+$/);
  assert.equal(sudoCalls[1], `${s.dest} install`);
  assert.equal(sudoCalls[2], "ufw reload");
  assert.equal(readFileSync(s.fixtureLog, "utf-8").trim(), "install", "ufw-docker install ran from the installed file");
  assert.deepEqual(readdirSync(s.tmpDir), [], "no temp file is left behind");
  assert.match(r.stdout, /ufw-docker installed/);
  assert.match(r.stdout, /ufw reloaded/);
});

test("K7: a download that does not match the pinned checksum fails closed — nothing installed, nothing run as root", () => {
  // The pin is the hash of one body; the shim delivers a different one.
  const s = ufwDockerScratch({ pinBody: "the reviewed file\n", body: "#!/bin/sh\n# something else\nexit 0\n" });
  const r = runUfwDocker(s);
  assert.equal(r.status, 1, `a bad checksum must end the install:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout,
    /ufw-docker download did not match the pinned checksum, so it was not installed; Docker-published ports would bypass the firewall\. The file upstream may have changed or been tampered with, or your network altered it: do not install it by hand\. Run the installer again later, or report it\./);
  assert.match(r.stdout, /do not install it by hand/);
  // The second line still shows both hashes.
  assert.match(r.stdout, /\(got sha256 \S+, the pinned commit 020a8699f95592561f254d8d4ad1bb40d401dfc7 is \S+\)/);
  assert.equal(existsSync(s.dest), false, "nothing is installed");
  assert.deepEqual(logLines(s.sudoLog), [], "nothing runs as root");
  assert.deepEqual(readdirSync(s.tmpDir), [], "the temp file is removed");
});

test("K7: a failed download fails closed too — nothing installed, nothing run as root", () => {
  const s = ufwDockerScratch({ downloadOk: false });
  const r = runUfwDocker(s);
  assert.equal(r.status, 1, `a failed download must end the install:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /Could not download ufw-docker from the pinned commit 020a8699f95592561f254d8d4ad1bb40d401dfc7/);
  assert.match(r.stdout, /Docker-published ports would bypass the firewall/);
  assert.equal(existsSync(s.dest), false, "nothing is installed");
  assert.deepEqual(logLines(s.sudoLog), [], "nothing runs as root");
  assert.deepEqual(readdirSync(s.tmpDir), [], "the temp file is removed");
});

test("K7: an existing ufw-docker that matches the pin is not downloaded again, but its rules are still wired", () => {
  const s = ufwDockerScratch();
  const pinned = readFileSync(s.served, "utf-8");
  writeFileSync(s.dest, pinned, { mode: 0o755 });
  const r = runUfwDocker(s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(logLines(s.curlLog), [], "the curl shim is never called");
  // A matching FILE says nothing about the RULES: a first run interrupted
  // between installing the file and running its own `install` leaves the file
  // with no after.rules entries, and no later run would ever write them.
  // Upstream's `install` is idempotent, so it runs here too — and ufw is
  // reloaded, so the rules are live without waiting for a reboot.
  assert.deepEqual(logLines(s.sudoLog), [`${s.dest} install`, "ufw reload"],
    "the matching-copy path wires the rules and reloads ufw");
  assert.equal(readFileSync(s.fixtureLog, "utf-8").trim(), "install", "ufw-docker install ran from the existing file");
  assert.equal(readFileSync(s.dest, "utf-8"), pinned, "the file is left as it is");
  assert.match(r.stdout, /already installed .*matches the pinned checksum/);
});

test("K7: a destination that is not a regular file fails closed — no download, nothing run as root", () => {
  // [ -f ] is FALSE for a directory, so the old code fell straight through to
  // the download and would have left the file inside the directory.
  const s = ufwDockerScratch();
  mkdirSync(s.dest);
  const r = runUfwDocker(s);
  assert.equal(r.status, 1, `a directory at the destination must end the install:\n${r.stdout}${r.stderr}`);
  // An `error` line (the ✗ is followed by the colour reset, hence `.*`).
  assert.match(r.stdout, /✗.*exists but is not a regular file/);
  assert.match(r.stdout, /Docker-published ports would bypass the firewall/);
  assert.deepEqual(logLines(s.curlLog), [], "nothing is downloaded");
  assert.deepEqual(logLines(s.sudoLog), [], "nothing runs as root");
  assert.deepEqual(readdirSync(s.tmpDir), [], "no temp file is created");
  assert.equal(statSync(s.dest).isDirectory(), true, "the directory is untouched");
});

test("K7: an existing, different ufw-docker is reported and replaced through the verified path", () => {
  // What the old installer left behind — any copy of the moving branch.
  const older = "#!/bin/sh\n# an older copy from the branch that used to move\nexit 0\n";
  const s = ufwDockerScratch({ existing: older });
  const r = runUfwDocker(s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /is not the pinned ufw-docker/);
  assert.match(r.stdout, /replacing it with the pinned copy/);
  assert.equal(logLines(s.curlLog).length, 1, "the verified path really ran");
  assert.equal(readFileSync(s.dest, "utf-8"), readFileSync(s.served, "utf-8"), "replaced with the pinned bytes");
  const sudoCalls = logLines(s.sudoLog);
  assert.match(sudoCalls[0], /^install -T -m 755 \S+ \S+$/);
  assert.equal(sudoCalls[1], `${s.dest} install`);
  assert.equal(sudoCalls[2], "ufw reload", "the replaced copy's rules are reloaded too");
});

test("K7: the installer pins ufw-docker to a commit AND a sha256, and raw/master is gone", () => {
  const s = src();
  assert.doesNotMatch(s, /raw\/master\/ufw-docker/, "the moving master URL must not come back");
  assert.doesNotMatch(s, /chaifeng\/ufw-docker\/raw\//, "nor any other branch-relative URL");
  assert.match(s, /^UFW_DOCKER_COMMIT="020a8699f95592561f254d8d4ad1bb40d401dfc7"$/m);
  assert.match(s, /^UFW_DOCKER_URL="https:\/\/raw\.githubusercontent\.com\/chaifeng\/ufw-docker\/\$\{UFW_DOCKER_COMMIT\}\/ufw-docker"$/m);
  assert.match(s, /^UFW_DOCKER_SHA256="\$\{UFW_DOCKER_SHA256:-643e56b080567c567b4aa28650196849b2a2da5dd0473fd3e5216b0886035ab0\}"$/m);

  const block = s.slice(s.indexOf("# ─── ufw-docker, pinned"), s.indexOf("# Test seam: tests source the helpers"));
  assert.ok(block.includes("UFW_DOCKER_COMMIT"), "the step must be defined above the source-only seam");
  // The bump instructions name the commit and the checksum TOGETHER.
  assert.match(block, /Bump BOTH values together/);
  assert.match(block, /chaifeng\/ufw-docker\/commits\/master/);
  // Downloaded as the invoking user (the CROW_CURL seam) into a temp file …
  assert.match(block, /"\$CROW_CURL" -fsSL "\$UFW_DOCKER_URL" -o "\$tmp"/);
  assert.doesNotMatch(block, /sudo[^\n]*curl/, "root never downloads");
  assert.doesNotMatch(block, /-o "\$UFW_DOCKER_DEST"/, "never straight into the destination");
  // …verified …
  assert.match(block, /sha256sum "\$1"/);
  assert.match(block, /"\$actual" != "\$UFW_DOCKER_SHA256"/);
  // …and only then installed, through the script's own sudo seam. -T keeps
  // `install` from ever treating a directory as a place to put the file.
  assert.match(block, /sudo_cmd install -T -m 755 "\$tmp" "\$UFW_DOCKER_DEST"/);
  assert.match(block, /sudo_cmd "\$UFW_DOCKER_DEST" install/);
  // A destination that exists but is no regular file is refused up front:
  // [ -f ] is false for it, so without this guard the download would run.
  assert.match(block, /if \[ -e "\$UFW_DOCKER_DEST" \] && \[ ! -f "\$UFW_DOCKER_DEST" \]; then/);
  // Both paths that wire the rules reload ufw afterwards (ufw came up first).
  assert.equal((block.match(/sudo_cmd ufw reload/g) || []).length, 2, "one reload per ufw-docker install");
  // The checksum branch removes the temp file and exits 1 — before the install.
  const failClosed = block.slice(block.indexOf('if [ "$actual" != "$UFW_DOCKER_SHA256" ]'), block.indexOf("sudo_cmd install -T -m 755"));
  assert.match(failClosed, /rm -f "\$tmp"/);
  assert.match(failClosed, /exit 1/);
  // The seams are the script's usual kind.
  assert.match(s, /^CROW_CURL="\$\{CROW_CURL:-curl\}"$/m);
  assert.match(s, /^UFW_DOCKER_DEST="\$\{UFW_DOCKER_DEST:-\/usr\/local\/bin\/ufw-docker\}"$/m);
});

test("K7: the ufw-docker step can only run in tests with the scratch seams set", () => {
  assert.throws(() => runWithHelpers("install_ufw_docker"), /UFW_DOCKER_DEST is required/);
});

// ─── Install re-run N4-1: one PATH line, not one per run ─
// The guard used to grep for "crow/scripts", which the line it writes never
// contains ($CROW_APP is ~/.crow/app), so every re-run appended another copy.

/** A scratch HOME; CROW_APP (and so the written line) follows it. */
function pathScratch() {
  const home = mkdtempSync(join(tmpdir(), "crow-pathline-"));
  return { home, rc: join(home, ".bashrc"), env: { HOME: home } };
}

const crowPathLine = (home) => `export PATH="$PATH:${join(home, ".crow", "app", "scripts")}"`;

test("N4-1: running the PATH step twice appends the one line exactly once", () => {
  const s = pathScratch();
  const first = runWithHelpers("add_crow_to_path", s.env);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(s.rc, "utf-8"), crowPathLine(s.home) + "\n");

  const second = runWithHelpers("add_crow_to_path", s.env);
  assert.equal(second.status, 0, second.stderr);
  const body = readFileSync(s.rc, "utf-8");
  assert.equal(body, crowPathLine(s.home) + "\n", "a re-run must append nothing");
  assert.equal(body.split("\n").filter((l) => l === crowPathLine(s.home)).length, 1);
  assert.doesNotMatch(second.stdout, /Added 'crow' command/, "and must not claim to have added it");
});

test("N4-1: a pre-existing, different PATH line is left alone and the crow line joins it once", () => {
  const s = pathScratch();
  // A SECOND install location, as an operator who moved the checkout has it.
  const other = 'export PATH="$PATH:$HOME/bin"';
  writeFileSync(s.rc, other + "\n");
  for (let i = 0; i < 2; i += 1) {
    const r = runWithHelpers("add_crow_to_path", s.env);
    assert.equal(r.status, 0, r.stderr);
  }
  const lines = readFileSync(s.rc, "utf-8").split("\n").filter(Boolean);
  assert.equal(lines[0], other, "the operator's own line is untouched");
  assert.deepEqual(lines.slice(1), [crowPathLine(s.home)], "exactly one crow line, however often it runs");
});

test("N4-1: a .bashrc with no trailing newline keeps its last line whole and gets the export on its own line", () => {
  const s = pathScratch();
  // What a hand-edited .bashrc often looks like: the last line has no newline.
  // An unconditional `printf … >>` would GLUE the export onto it, so the
  // operator's last line becomes `alias …export PATH=…` and neither line works.
  writeFileSync(s.rc, 'alias g="git status"');
  const r = runWithHelpers("add_crow_to_path", s.env);
  assert.equal(r.status, 0, r.stderr);
  const body = readFileSync(s.rc, "utf-8");
  assert.equal(body, `alias g="git status"\n${crowPathLine(s.home)}\n`,
    "the last line survives whole, and a newline was written before the export");
  assert.deepEqual(body.split("\n").slice(0, 2), ['alias g="git status"', crowPathLine(s.home)]);
  // A re-run adds neither another newline nor a second export line.
  const again = runWithHelpers("add_crow_to_path", s.env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(s.rc, "utf-8"), body);
});

test("N4-1: the old substring guard and the inline append are gone; the helper is above the seam and called below it", () => {
  const s = src();
  assert.doesNotMatch(s, /grep -q "crow\/scripts"/, "the guard that never matched the line it wrote");
  assert.doesNotMatch(s, /echo "export PATH=/, "the inline append is gone too");
  assert.match(s, /grep -qxF -- "\$CROW_PATH_LINE" "\$HOME\/\.bashrc"/, "the guard compares the exact line");
  const seamIdx = s.indexOf("CROW_INSTALL_SOURCE_ONLY");
  const defIdx = s.indexOf("add_crow_to_path() {");
  const callIdx = s.indexOf("\nadd_crow_to_path\n");
  assert.ok(defIdx > -1 && defIdx < seamIdx, "defined above the seam so tests can source it");
  assert.ok(callIdx > seamIdx, "and called in the install body");
});
