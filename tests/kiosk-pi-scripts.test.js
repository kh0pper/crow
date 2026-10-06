// The Pi side of the kiosk (scripts/kiosk): setup script, agent, Chromium policy, memory sampler.
// Python and shellcheck parts skip when the tool is missing on the box running the suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const K = join(ROOT, "scripts/kiosk");
const have = (cmd, args = ["--version"]) => !spawnSync(cmd, args, { stdio: "ignore" }).error;
const python = () => have("python3") && spawnSync("python3", ["-c", "import numpy"], { stdio: "ignore" }).status === 0;
const ORIGIN = "https://crow.example.ts.net:8444";

test("shell scripts pass shellcheck (skips without shellcheck)", (t) => {
  if (!have("shellcheck")) return t.skip("shellcheck not installed");
  const r = spawnSync("shellcheck", ["pi-setup.sh", "kiosk-launch.sh", "mem-sample.sh", "after-dpkg.sh", "repair-speaker.sh", "bt-recover.sh"], { cwd: K, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("agent unit tests pass (python3 + numpy; websockets tests skip without it)", (t) => {
  if (!python()) return t.skip("python3 with numpy not available");
  const r = spawnSync("python3", ["-W", "error::ResourceWarning", "-m", "unittest", "discover", "-s", join(K, "agent"), "-p", "test_*.py"], { encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /\nOK/);
});

test("pi-setup.sh --dry-run renders every file, changes nothing on the host, and is idempotent", (t) => {
  if (!have("python3")) return t.skip("python3 not available");
  const dir = mkdtempSync(join(tmpdir(), "kiosk-dry-"));
  try {
    const args = ["--crow-url", ORIGIN + "/", "--bt-sink", "00:11:22:aa:bb:cc", "--accept-oww-model-license", "--auto-reboot", "--dry-run", dir];
    const env = { ...process.env, SUDO_USER: "alex" };
    const r1 = spawnSync("bash", [join(K, "pi-setup.sh"), ...args], { encoding: "utf8", env });
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    for (const f of ["etc/crow-kiosk/agent.json", "etc/crow-kiosk/kiosk.env", "etc/chromium/policies/managed/crow-kiosk.json",
      "etc/systemd/system/crow-kiosk-cage.service", "etc/pam.d/crow-kiosk", "etc/udev/rules.d/90-crow-kiosk-backlight.rules",
      "home/kiosk/.config/systemd/user/crow-kiosk-agent.service", "home/kiosk/.config/wireplumber/wireplumber.conf.d/51-crow-kiosk-bluez.conf",
      "usr/local/lib/crow-kiosk/agent/crow_kiosk_agent.py", "usr/local/lib/crow-kiosk/mem-sample.sh",
      "usr/local/lib/crow-kiosk/after-dpkg.sh", "etc/apt/apt.conf.d/80crow-kiosk-after-dpkg",
      "etc/systemd/system/apt-daily-upgrade.timer.d/crow-kiosk.conf", "etc/systemd/system/apt-daily.timer.d/crow-kiosk.conf",
      "etc/systemd/system.conf.d/90-crow-kiosk-watchdog.conf", "etc/NetworkManager/conf.d/90-crow-kiosk-wifi-powersave.conf",
      "etc/crow-kiosk/setup.env", "home/alex/.config/systemd/user/mpris-proxy.service"]) {
      assert.ok(existsSync(join(dir, f)), f);
    }
    assert.ok(!readdirSync(join(dir, "usr/local/lib/crow-kiosk/agent")).some((f) => f.startsWith("test_") || f.startsWith("_")), "tests and test helpers are not installed");
    const cfg = JSON.parse(readFileSync(join(dir, "etc/crow-kiosk/agent.json"), "utf8"));
    assert.deepEqual(cfg, { bt_sink_mac: "00:11:22:AA:BB:CC", crow_origin: ORIGIN, mic_target: null, wake_model: "/var/lib/crow-kiosk/wake/hey_jarvis_v0.1.onnx", wake_step: 1, wake_threads: 2 });
    assert.match(readFileSync(join(dir, "etc/systemd/system/apt-daily-upgrade.timer.d/crow-kiosk.conf"), "utf8"), /^OnCalendar=\*-\*-\* 03:30$/m, "upgrades run inside the sleep window");
    assert.doesNotMatch(readFileSync(join(dir, "home/kiosk/.config/systemd/user/crow-kiosk-agent.service"), "utf8"), /^MemoryMax/m, "memcg is off on the Pi: no fake cap");
    assert.equal(readFileSync(join(dir, "etc/crow-kiosk/kiosk.env"), "utf8"), `CROW_URL=${ORIGIN}\nROTATE=0\nBT_SINK=00:11:22:AA:BB:CC\n`);
    for (const f of ["usr/local/lib/crow-kiosk/bt-recover.sh", "etc/systemd/system/crow-kiosk-bt-recover.service", "etc/systemd/system/crow-kiosk-bt-recover.path",
      "etc/tmpfiles.d/crow-kiosk.conf", "home/kiosk/.config/wireplumber/wireplumber.conf.d/52-crow-kiosk-stream-targets.conf", "usr/local/lib/crow-kiosk/agent/bench_wake.py"]) {
      assert.ok(existsSync(join(dir, f)), f);
    }
    assert.match(readFileSync(join(dir, "home/kiosk/.config/wireplumber/wireplumber.conf.d/52-crow-kiosk-stream-targets.conf"), "utf8"), /node\.stream\.restore-target = false/);
    assert.match(readFileSync(join(dir, "etc/tmpfiles.d/crow-kiosk.conf"), "utf8"), /^f \/run\/crow-kiosk\/bt-recover\.request 0620 root kiosk -$/m);
    assert.match(r1.stdout, /\+ systemctl enable --now crow-kiosk-bt-recover\.path/);
    assert.ok(!existsSync(join(dir, "etc/crow-kiosk/bt-auto-reboot")), "automatic reboot is off by default");
    assert.doesNotMatch(r1.stdout, /python3-onnxruntime/, "Debian's onnxruntime dies with SIGILL on a Pi 3");
    assert.match(r1.stdout, /apt-get install .*\bwlr-randr\b/);
    assert.match(r1.stdout, /\+ python3 -m venv --system-site-packages \/opt\/crow-kiosk\/venv/);
    assert.match(r1.stdout, /pip install --disable-pip-version-check --no-deps --require-hashes -r \/opt\/crow-kiosk\/requirements\.txt/);
    assert.match(readFileSync(join(dir, "opt/crow-kiosk/requirements.txt"), "utf8"), /^onnxruntime==1\.30\.0 --hash=sha256:[0-9a-f]{64}$/m);
    assert.match(r1.stdout, /runuser -u kiosk -- \/opt\/crow-kiosk\/venv\/bin\/python \/usr\/local\/lib\/crow-kiosk\/check-onnxruntime\.py/);
    assert.match(readFileSync(join(dir, "home/kiosk/.config/systemd/user/crow-kiosk-agent.service"), "utf8"), /^ExecStart=\/opt\/crow-kiosk\/venv\/bin\/python /m);
    assert.equal(readFileSync(join(dir, "etc/ssh/sshd_config.d/10-crow-kiosk.conf"), "utf8").match(/^(PasswordAuthentication|KbdInteractiveAuthentication|PermitRootLogin) no$/gm).length, 3);
    assert.ok(!existsSync(join(dir, "etc/udev/rules.d/91-crow-kiosk-touch-rotation.rules")), "no rotation by default");
    assert.match(readFileSync(join(dir, "etc/apt/apt.conf.d/52crow-kiosk-unattended-upgrades"), "utf8"), /Automatic-Reboot "true"/);
    assert.match(readFileSync(join(dir, "etc/apt/apt.conf.d/52crow-kiosk-unattended-upgrades"), "utf8"), /Automatic-Reboot-Time "04:30"/);
    assert.match(r1.stdout, /\+ apt-get update/);
    assert.match(r1.stdout, /\+ curl -fsSL --proto =https .*hey_jarvis_v0\.1\.onnx/);
    const r2 = spawnSync("bash", [join(K, "pi-setup.sh"), ...args], { encoding: "utf8", env });
    assert.equal(r2.status, 0);
    assert.doesNotMatch(r2.stdout, /\bwrote\b|\blinked\b/, "second run changes no file");
    assert.match(r2.stdout, /nothing changed/);
    // a later run with only one new flag keeps every saved setting
    const sha = "a".repeat(64);
    const r3 = spawnSync("bash", [join(K, "pi-setup.sh"), "--wake-model-url", "https://crow.example.ts.net:8444/display/assets/wake/hey_crow.onnx", "--wake-model-sha256", sha, "--dry-run", dir], { encoding: "utf8", env });
    assert.equal(r3.status, 0, r3.stdout + r3.stderr);
    const cfg3 = JSON.parse(readFileSync(join(dir, "etc/crow-kiosk/agent.json"), "utf8"));
    assert.equal(cfg3.bt_sink_mac, "00:11:22:AA:BB:CC", "the speaker survives a re-run without --bt-sink");
    assert.equal(cfg3.wake_model, "/var/lib/crow-kiosk/wake/hey_crow.onnx");
    assert.match(r3.stdout, /restart crow-kiosk-agent\.service/, "a changed install restarts the agent");
    assert.match(r3.stdout, /systemctl restart crow-kiosk-cage\.service/);
    const r4 = spawnSync("bash", [join(K, "pi-setup.sh"), "--clear-bt-sink", "--dry-run", dir], { encoding: "utf8", env });
    assert.equal(r4.status, 0, r4.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, "etc/crow-kiosk/agent.json"), "utf8")).bt_sink_mac, null);
    assert.match(readFileSync(join(dir, "etc/crow-kiosk/setup.env"), "utf8"), /^WAKE_SHA=a{64}$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--rotate rotates the display at launch and the touchscreen through libinput, and is remembered", (t) => {
  if (!have("python3")) return t.skip("python3 not available");
  const dir = mkdtempSync(join(tmpdir(), "kiosk-rot-"));
  const env = { ...process.env, SUDO_USER: "alex" };
  try {
    const run = (...a) => spawnSync("bash", [join(K, "pi-setup.sh"), ...a, "--dry-run", dir], { encoding: "utf8", env });
    let r = run("--crow-url", ORIGIN, "--rotate", "180");
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(dir, "etc/udev/rules.d/91-crow-kiosk-touch-rotation.rules"), "utf8"),
      /ENV\{ID_INPUT_TOUCHSCREEN\}=="1", ENV\{LIBINPUT_CALIBRATION_MATRIX\}="-1 0 1 0 -1 1"/);
    assert.match(readFileSync(join(dir, "etc/crow-kiosk/kiosk.env"), "utf8"), /^ROTATE=180$/m);
    assert.match(r.stdout, /udevadm trigger --subsystem-match=input --action=change/);
    r = run();                                     // remembered
    assert.match(readFileSync(join(dir, "etc/crow-kiosk/kiosk.env"), "utf8"), /^ROTATE=180$/m);
    r = run("--rotate", "0");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\+ rm -f \/etc\/udev\/rules\.d\/91-crow-kiosk-touch-rotation\.rules/);
    assert.equal(run("--rotate", "45").status, 2);
    const launch = readFileSync(join(K, "kiosk-launch.sh"), "utf8");
    assert.match(launch, /wlr-randr --output "\$OUTPUT" --transform "\$TRANSFORM"/);
    assert.ok(launch.indexOf("wlr-randr --output") < launch.indexOf("exec /usr/bin/chromium"), "rotate before Chromium starts");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the ssh check does not pipe sshd -T into grep -q (pipefail + SIGPIPE gave a false warning)", () => {
  const src = readFileSync(join(K, "pi-setup.sh"), "utf8");
  assert.doesNotMatch(src, /sshd -T[^\n]*\|\s*grep/);
  assert.match(src, /SSHD_T="\$\(sshd -T/);
});

test("Bluetooth: classic-only controller mode (original kept), bluetoothd + WirePlumber restarted together", (t) => {
  if (!have("python3")) return t.skip("python3 not available");
  const dir = mkdtempSync(join(tmpdir(), "kiosk-bt-"));
  const env = { ...process.env, SUDO_USER: "alex" };
  try {
    const conf = "[General]\n#Name = BlueZ\n#ControllerMode = dual\n\n[Policy]\nAutoEnable=true\n";
    mkdirSync(join(dir, "etc/bluetooth"), { recursive: true });
    writeFileSync(join(dir, "etc/bluetooth/main.conf"), conf);
    mkdirSync(join(dir, "etc/crow-kiosk"), { recursive: true });
    writeFileSync(join(dir, "etc/crow-kiosk/setup.env"), "CROW_URL=" + ORIGIN + "\nBT_SINK=00:11:22:33:44:55\n");  // not a first install
    const run = (...a) => spawnSync("bash", [join(K, "pi-setup.sh"), ...a, "--dry-run", dir], { encoding: "utf8", env });
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    const after = readFileSync(join(dir, "etc/bluetooth/main.conf"), "utf8");
    assert.match(after, /^\[General\]\n#Name = BlueZ\nControllerMode = bredr\n/);
    assert.match(after, /\[Policy\]\nAutoEnable=true/);
    assert.equal(readFileSync(join(dir, "etc/bluetooth/main.conf.orig"), "utf8"), conf);
    const restartBt = r.stdout.indexOf("+ systemctl restart bluetooth.service");
    const restartWp = r.stdout.indexOf("systemctl --user restart wireplumber.service");
    assert.ok(restartBt > 0 && restartWp > restartBt, "WirePlumber restarts right after bluetoothd");
    r = run();
    assert.doesNotMatch(r.stdout, /restart bluetooth\.service/, "unchanged config: no restart");
    assert.equal(readFileSync(join(dir, "etc/bluetooth/main.conf.orig"), "utf8"), conf, ".orig is written once");
    r = run("--repair-speaker");
    assert.match(r.stdout, /runuser -u kiosk -- env XDG_RUNTIME_DIR=\/run\/user\/\S+ \/usr\/local\/lib\/crow-kiosk\/repair-speaker\.sh 00:11:22:33:44:55/);
    const stop = r.stdout.indexOf("systemctl --user stop crow-kiosk-agent.service");
    const repair = r.stdout.indexOf("repair-speaker.sh 00:11:22:33:44:55");
    const start = r.stdout.indexOf("systemctl --user start crow-kiosk-agent.service");
    assert.ok(stop > 0 && stop < repair && repair < start, "the agent is paused around the re-pairing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("repair-speaker.sh: remove, scan until seen, pair, trust, connect — only the given address", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kiosk-repair-"));
  try {
    const log = join(dir, "calls");
    const fake = join(dir, "bluetoothctl");
    writeFileSync(fake, `#!/bin/bash
echo "$*" >> "${log}"
case "$1" in
  devices) n=$(grep -c '^devices' "${log}"); [ "$n" -ge 2 ] && echo "Device 00:11:22:AA:BB:CC Kitchen speaker" ;;
  info) echo "Device $2"; echo "	Connected: yes" ;;
  --timeout) sleep 0.2 ;;
esac
exit 0
`, { mode: 0o755 });
    const r = spawnSync("bash", [join(K, "repair-speaker.sh"), "00:11:22:aa:bb:cc", "--yes"], { encoding: "utf8", env: { ...process.env, CROW_KIOSK_BTCTL: fake }, timeout: 30000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const calls = readFileSync(log, "utf8").trim().split("\n").filter((l) => !l.startsWith("devices") && !l.startsWith("--timeout"));
    assert.deepEqual(calls, ["remove 00:11:22:AA:BB:CC", "scan off", "pair 00:11:22:AA:BB:CC", "trust 00:11:22:AA:BB:CC", "connect 00:11:22:AA:BB:CC", "info 00:11:22:AA:BB:CC"]);
    for (const bad of [["nope"], ["00:11:22:33:44:55;reboot"], ["00:11:22:33:44:55", "--force"]]) {
      assert.equal(spawnSync("bash", [join(K, "repair-speaker.sh"), ...bad], { env: { ...process.env, CROW_KIOSK_BTCTL: fake } }).status, 2, bad.join(" "));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bt-recover.sh: acts only on hci0 evidence, rebinds the serdev device, restarts bluetoothd then WirePlumber, never re-pairs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kiosk-btrec-"));
  try {
    const root = join(dir, "root"), bin = join(dir, "bin"), log = join(dir, "calls");
    const drv = join(root, "sys/bus/serial/drivers/hci_uart_bcm");
    mkdirSync(drv, { recursive: true }); mkdirSync(bin);
    mkdirSync(join(drv, "serial0-0"));
    writeFileSync(join(drv, "unbind"), ""); writeFileSync(join(drv, "bind"), "");
    const fake = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
    fake("journalctl", `[ -f "${dir}/fault" ] && echo "Oct 05 kernel: Bluetooth: hci0: command 0x0406 tx timeout"; exit 0`);
    fake("bluetoothctl", `[ "$1" = show ] && [ -f "${dir}/powered" ] && echo "	Powered: yes"; exit 0`);
    fake("systemctl", "exit 0"); fake("runuser", "exit 0"); fake("logger", "exit 0"); fake("id", `echo 1001`); fake("sleep", "exit 0");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CROW_KIOSK_TEST_ROOT: root, CROW_KIOSK_BT_WAIT: "2" };
    const run = () => spawnSync("bash", [join(K, "bt-recover.sh")], { encoding: "utf8", env });
    const state = () => readFileSync(join(root, "run/crow-kiosk/bt-recover.state"), "utf8").split(" ")[0];
    const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

    assert.equal(run().status, 0); assert.equal(state(), "no_fault");
    assert.equal(readFileSync(join(drv, "unbind"), "utf8"), "", "no evidence: nothing touched");

    writeFileSync(join(dir, "fault"), ""); writeFileSync(join(dir, "powered"), "");
    assert.equal(run().status, 0); assert.equal(state(), "ok");
    assert.equal(readFileSync(join(drv, "unbind"), "utf8").trim(), "serial0-0");
    assert.equal(readFileSync(join(drv, "bind"), "utf8").trim(), "serial0-0");
    const c = calls();
    assert.ok(c.indexOf("systemctl restart bluetooth.service") < c.indexOf("runuser -u kiosk"), "bluetoothd first, then the kiosk WirePlumber");
    assert.match(c, /systemctl --user restart wireplumber\.service/);
    assert.doesNotMatch(c, /bluetoothctl (remove|pair|trust)/, "recovery never re-pairs");

    assert.equal(run().status, 0); assert.equal(state(), "rate_limited", "at most once per 10 minutes");

    writeFileSync(join(root, "var/lib/crow-kiosk/bt-recover.log"), "");
    rmSync(join(dir, "powered"));
    assert.equal(run().status, 0); assert.equal(state(), "needs_restart", "controller stays dead, no auto-reboot");
    assert.doesNotMatch(calls(), /systemctl reboot/);

    writeFileSync(join(root, "var/lib/crow-kiosk/bt-recover.log"), "");
    mkdirSync(join(root, "etc/crow-kiosk"), { recursive: true }); writeFileSync(join(root, "etc/crow-kiosk/bt-auto-reboot"), "");
    assert.equal(run().status, 0);
    assert.match(calls(), /systemctl reboot/, "operator-enabled reboot");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("kiosk-launch.sh waits (bounded) for the speaker's sink before starting Chromium", () => {
  const launch = readFileSync(join(K, "kiosk-launch.sh"), "utf8");
  const wait = launch.indexOf("pactl list short sinks");
  assert.ok(wait > 0 && wait < launch.indexOf("exec /usr/bin/chromium"));
  assert.match(launch, /for _ in \$\(seq 1 20\)/);
});

test("pi-setup.sh never writes through a symlink planted in a user's home", (t) => {
  if (!have("python3")) return t.skip("python3 not available");
  const env = { ...process.env, SUDO_USER: "alex" };
  const cases = [
    ["home/kiosk/.config", "a symlinked directory in the kiosk home"],
    ["home/kiosk/.config/systemd/user/crow-kiosk-agent.service", "a symlinked target file"],
    ["home/alex/.config/systemd", "a symlinked directory in the admin home"],
    ["home/kiosk", "a symlinked home"],
  ];
  for (const [planted, what] of cases) {
    const dir = mkdtempSync(join(tmpdir(), "kiosk-link-"));
    try {
      const victim = join(dir, "victim");              // stands in for a root-owned file/dir elsewhere
      mkdirSync(victim);
      writeFileSync(join(victim, "secret"), "root-owned\n");
      const at = join(dir, "stage", planted);
      mkdirSync(dirname(at), { recursive: true });
      symlinkSync(victim, at);
      const r = spawnSync("bash", [join(K, "pi-setup.sh"), "--crow-url", ORIGIN, "--dry-run", join(dir, "stage")], { encoding: "utf8", env });
      assert.equal(r.status, 2, `${what}: must refuse\n${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /refusing/);
      assert.deepEqual(readdirSync(victim), ["secret"], `${what}: nothing written through the link`);
      assert.ok(lstatSync(at).isSymbolicLink());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("pi-setup.sh has no recursive chown and writes user homes only as that user", () => {
  const src = readFileSync(join(K, "pi-setup.sh"), "utf8");
  assert.doesNotMatch(src, /chown\s+-R/);
  assert.match(src, /runuser -u "\$u" --/);
  for (const line of src.split("\n").filter((l) => /(KHOME|AHOME)\/\.config/.test(l) && !l.trim().startsWith("#"))) {
    assert.match(line, /^\s*(uput|ulink)\s/, `user-home write must go through uput/ulink: ${line.trim()}`);
  }
});

test("pi-setup.sh refuses bad arguments before touching anything", (t) => {
  if (!have("python3")) return t.skip("python3 not available");
  const dir = mkdtempSync(join(tmpdir(), "kiosk-dry-"));
  try {
    for (const bad of [[], ["--crow-url", "http://crow.example.ts.net"], ["--crow-url", ORIGIN + "/display"],
      ["--crow-url", ORIGIN, "--bt-sink", "00:11"], ["--crow-url", ORIGIN, "--bt-sink", "00:11:22:33:44:55;reboot"],
      ["--crow-url", ORIGIN, "--wake-model-url", "https://crow.example.ts.net/x.onnx"],
      ["--crow-url", ORIGIN, "--wake-model-url", "http://crow.example.ts.net/x.onnx", "--wake-model-sha256", "a".repeat(64)],
      ["--crow-url", ORIGIN, "--admin-user", "kiosk"], ["--crow-url", ORIGIN, "--reboot-time", "4am"], ["--nope"],
      ["--crow-url", ORIGIN, "--bt-sink", "00:11:22:33:44:55", "--keep-admin-audio"],
      ["--crow-url", ORIGIN, "--wake-model-url", "https://crow.example.ts.net/x/..", "--wake-model-sha256", "a".repeat(64)],
      ["--crow-url", ORIGIN, "--mic-target", "x;reboot"], ["--crow-url", ORIGIN, "--repair-speaker"],
      ["--crow-url", ORIGIN, "--wake-threads", "8"], ["--crow-url", ORIGIN, "--wake-step", "0"]]) {
      const r = spawnSync("bash", [join(K, "pi-setup.sh"), ...bad, "--dry-run", join(dir, "x")], { encoding: "utf8" });
      assert.equal(r.status, 2, `${bad.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.ok(!existsSync(join(dir, "x", "etc")), "nothing written");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Names checked against Chromium's components/policy/resources/templates/policies.yaml on 2026-10-05.
const KNOWN_POLICIES = new Set(["URLBlocklist", "URLAllowlist", "AudioCaptureAllowed", "AudioCaptureAllowedUrls", "VideoCaptureAllowed",
  "ScreenCaptureAllowed", "AutoplayAllowed", "AutoplayAllowlist", "LoopbackNetworkAllowedForUrls",
  "DeveloperToolsAvailability", "TaskManagerEndProcessEnabled", "IncognitoModeAvailability", "BrowserGuestModeEnabled",
  "BrowserAddPersonEnabled", "BrowserSignin", "SyncDisabled", "ExtensionInstallBlocklist", "AllowFileSelectionDialogs",
  "DownloadRestrictions", "PrintingEnabled", "DefaultPopupsSetting", "DefaultNotificationsSetting", "DefaultGeolocationSetting",
  "PasswordManagerEnabled", "AutofillAddressEnabled", "AutofillCreditCardEnabled", "TranslateEnabled", "SpellcheckEnabled",
  "SearchSuggestEnabled", "MetricsReportingEnabled", "BackgroundModeEnabled", "DefaultBrowserSettingEnabled",
  "CommandLineFlagSecurityWarningsEnabled", "HardwareAccelerationModeEnabled"]);

test("Chromium policy: known names only, Crow origin only, no dev tools, loopback socket granted", (t) => {
  if (!have("python3")) return t.skip("python3 not available");
  const r = spawnSync("python3", [join(K, "chromium_policy.py"), "--crow-url", ORIGIN + "/"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  for (const k of Object.keys(p)) assert.ok(KNOWN_POLICIES.has(k), `unknown policy ${k}`);
  assert.deepEqual(p.URLAllowlist, [ORIGIN + "/display"], "navigation fenced to the kiosk page");
  assert.ok(p.URLBlocklist.includes("*") && p.URLBlocklist.includes("chrome://*"), "chrome:// is not covered by * since Chromium 147");
  assert.ok(p.URLBlocklist.includes("view-source:*"));
  assert.equal(p.LocalNetworkAccessAllowedForUrls, undefined, "that policy would also open the LAN");
  assert.deepEqual(p.AudioCaptureAllowedUrls, [ORIGIN]);
  assert.deepEqual(p.AutoplayAllowlist, [ORIGIN]);
  assert.deepEqual(p.LoopbackNetworkAllowedForUrls, [ORIGIN]);
  assert.equal(p.DeveloperToolsAvailability, 2);
  assert.equal(p.VideoCaptureAllowed, false);
  const f = JSON.parse(spawnSync("python3", [join(K, "chromium_policy.py"), "--crow-url", ORIGIN, "--allow-frame-origin", "https://www.youtube-nocookie.com/"], { encoding: "utf8" }).stdout);
  assert.deepEqual(f.URLAllowlist, [ORIGIN + "/display", "https://www.youtube-nocookie.com"]);
  assert.deepEqual(f.AudioCaptureAllowedUrls, [ORIGIN], "frames never get the mic");
  for (const bad of ["http://crow.example.ts.net", ORIGIN + "/display", "https://user:pw@crow.example.ts.net"]) {
    assert.equal(spawnSync("python3", [join(K, "chromium_policy.py"), "--crow-url", bad]).status, 2, bad);
  }
});

test("kiosk page CSP and the agent agree on the local socket", () => {
  const runtime = readFileSync(join(ROOT, "bundles/kiosk/server/runtime.js"), "utf8");
  assert.match(runtime, /connect-src 'self' ws:\/\/127\.0\.0\.1:8770/);
  assert.match(readFileSync(join(K, "agent/config.py"), "utf8"), /"listen_port": 8770/);
  assert.match(readFileSync(join(K, "kiosk-launch.sh"), "utf8"), /\$\{CROW_URL\}\/display\?agent=1"/, "the page lives at /display; ?agent=1 opens the agent socket");
});

test("mem-sample.sh sums chromium Pss from smaps_rollup", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kiosk-proc-"));
  try {
    const proc = (pid, comm, pss) => { mkdirSync(join(dir, String(pid))); writeFileSync(join(dir, String(pid), "comm"), comm + "\n"); writeFileSync(join(dir, String(pid), "smaps_rollup"), `Rss: 9 kB\nPss: ${pss} kB\n`); };
    proc(100, "chromium", 120000); proc(101, "chromium", 30500); proc(102, "chrome_crashpad", 1000); proc(200, "crow-kiosk-agen", 41000); proc(300, "bash", 7);
    writeFileSync(join(dir, "meminfo"), "MemTotal: 926000 kB\nMemAvailable: 500000 kB\nSwapTotal: 926716 kB\nSwapFree: 900000 kB\n");
    const out = join(dir, "mem.csv");
    const r = spawnSync("bash", [join(K, "mem-sample.sh")], { encoding: "utf8", env: { ...process.env, CROW_KIOSK_PROC: dir, CROW_KIOSK_MEM_CSV: out } });
    assert.equal(r.status, 0, r.stderr);
    const [head, row] = readFileSync(out, "utf8").trim().split("\n");
    assert.equal(head, "time,chromium_pss_kb,chromium_procs,agent_pss_kb,mem_available_kb,swap_used_kb");
    assert.deepEqual(row.split(",").slice(1), ["151500", "3", "41000", "500000", "26716"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("speaker reconnect: the agent's whole-attempt deadline leaves the page's 30 s wait a 2 s margin", () => {
  // The kiosk page waits 30 s for a bt_reconnect answer and the server relay 35 s; the agent must answer first.
  const bt = readFileSync(join(K, "agent/bt.py"), "utf8");
  const agentS = Number(bt.match(/^ATTEMPT_DEADLINE_S = \(?\s*(\d+)/m)[1]);
  assert.ok(agentS * 1000 + 2000 <= 30000, `agent ${agentS}s + 2s <= 30s`);
});
