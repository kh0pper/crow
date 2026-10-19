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

test("pi-setup helper unit tests pass (boot config, BlueZ main.conf, controller diagnosis)", (t) => {
  if (!have("python3")) return t.skip("python3 not available");
  const r = spawnSync("python3", ["-W", "error::ResourceWarning", "-m", "unittest", "discover", "-s", K, "-p", "test_setup_helpers.py"], { encoding: "utf8", timeout: 60000 });
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
    assert.match(r1.stdout, /\+ systemctl enable crow-kiosk-bt-recover\.path\n(.*\n)*\+ systemctl start crow-kiosk-bt-recover\.path/);
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

test("Bluetooth: classic-only controller mode + AutoEnable (original kept), bluetoothd + WirePlumber restarted together", (t) => {
  if (!have("python3")) return t.skip("python3 not available");
  const dir = mkdtempSync(join(tmpdir(), "kiosk-bt-"));
  const env = { ...process.env, SUDO_USER: "alex" };
  try {
    const conf = "[General]\n#Name = BlueZ\n#ControllerMode = dual\n\n[Policy]\n#AutoEnable=true\n";
    mkdirSync(join(dir, "etc/bluetooth"), { recursive: true });
    writeFileSync(join(dir, "etc/bluetooth/main.conf"), conf);
    mkdirSync(join(dir, "etc/crow-kiosk"), { recursive: true });
    writeFileSync(join(dir, "etc/crow-kiosk/setup.env"), "CROW_URL=" + ORIGIN + "\nBT_SINK=00:11:22:33:44:55\n");  // not a first install
    const run = (...a) => spawnSync("bash", [join(K, "pi-setup.sh"), ...a, "--dry-run", dir], { encoding: "utf8", env });
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    const after = readFileSync(join(dir, "etc/bluetooth/main.conf"), "utf8");
    assert.match(after, /^\[General\]\n#Name = BlueZ\nControllerMode = bredr\n/);
    assert.match(after, /\[Policy\]\nAutoEnable=true\n/, "BlueZ powers every controller it manages (the USB adapter too)");
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

// Placeholder addresses only (public repository): onboard, USB adapter, speaker.
const ONBOARD = "AA:BB:CC:DD:EE:01", USBBT = "AA:BB:CC:DD:EE:02", SPEAKER = "00:11:22:33:44:55";
const SERIAL_DEV = "sys/devices/platform/soc/3f201000.serial/3f201000.serial:0/3f201000.serial:0.0/serial0/serial0-0";
const USB_DEV = "sys/devices/platform/soc/3f980000.usb/usb1/1-1/1-1.2";
const BOOT_STOCK = "# http://rptl.io/configtxt\ndtparam=audio=on\ndtoverlay=vc4-kms-v3d\narm_64bit=1\n\n[cm5]\ndtoverlay=dwc2,dr_mode=host\n\n[pi5]\ndtoverlay=nospi10\n\n[all]\n";
const BOOT_MARKED = "# crow-kiosk: onboard Bluetooth off (pi-setup --usb-bt)\ndtoverlay=disable-bt\n";
// A Pi 3 as sysfs shows it: the onboard UART controller and/or a USB adapter on port 1-1.2.
const piRoot = (dir, { serial = true, usb = true, boot = BOOT_STOCK } = {}) => {
  const ctl = (hci, dev) => {
    mkdirSync(join(dir, dev), { recursive: true });
    mkdirSync(join(dir, "sys/class/bluetooth", hci), { recursive: true });
    symlinkSync(join(dir, dev), join(dir, "sys/class/bluetooth", hci, "device"));
  };
  if (serial) ctl("hci0", SERIAL_DEV);
  if (usb) ctl("hci1", USB_DEV + "/1-1.2:1.0");
  if (boot !== null) { mkdirSync(join(dir, "boot/firmware"), { recursive: true }); writeFileSync(join(dir, "boot/firmware/config.txt"), boot); }
  mkdirSync(join(dir, "var/lib/systemd/rfkill"), { recursive: true });
  writeFileSync(join(dir, "var/lib/systemd/rfkill/platform-3f980000.usb-usb-0:1.2:1.0:bluetooth"), "1\n");
  writeFileSync(join(dir, "var/lib/systemd/rfkill/platform-3f300000.mmcnr:wlan"), "1\n");
};
// fake bluetoothctl / btmgmt answering as BlueZ does with the USB adapter as the default controller
const fakeBt = (bin, { defaultAddr = USBBT, blocked = false } = {}) => {
  mkdirSync(bin, { recursive: true });
  const hci = defaultAddr === USBBT ? "hci1" : "hci0";
  writeFileSync(join(bin, "bluetoothctl"), `#!/bin/bash
case "$1" in
  list) echo "Controller ${defaultAddr} kiosk [default]" ;;
  show) printf 'Controller ${defaultAddr} (public)\\n\\tPowered: ${blocked ? "no" : "yes"}\\n\\tPowerState: ${blocked ? "off-blocked" : "on"}\\n' ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(bin, "btmgmt"), `#!/bin/bash
[ "$1" = info ] && printf 'Index list with 1 item\\n${hci}:\\tPrimary controller\\n\\taddr ${defaultAddr} version 10 manufacturer 93 class 0x000000\\n'
exit 0
`, { mode: 0o755 });
  return { CROW_KIOSK_BTCTL: join(bin, "bluetoothctl"), CROW_KIOSK_BTMGMT: join(bin, "btmgmt") };
};

test("--usb-bt: onboard Bluetooth off in config.txt (backed up once, crash-safe), saved rfkill blocks cleared, reboot required", (t) => {
  if (!have("python3")) return t.skip("python3 not available");
  const dir = mkdtempSync(join(tmpdir(), "kiosk-usbbt-"));
  try {
    const st = join(dir, "st"), bin = join(dir, "bin");
    piRoot(st);
    mkdirSync(join(st, "var/lib/crow-kiosk"), { recursive: true });
    writeFileSync(join(st, "var/lib/crow-kiosk/bt-serdev"), "serial0-0\n");
    const env = { ...process.env, SUDO_USER: "alex", ...fakeBt(bin) };
    const run = (...a) => spawnSync("bash", [join(K, "pi-setup.sh"), ...a, "--dry-run", st], { encoding: "utf8", env });
    let r = run("--crow-url", ORIGIN, "--bt-sink", SPEAKER, "--usb-bt");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const cfg = join(st, "boot/firmware/config.txt");
    assert.equal(readFileSync(cfg, "utf8"), BOOT_STOCK + BOOT_MARKED);
    assert.equal(readFileSync(cfg + ".crow-kiosk.orig", "utf8"), BOOT_STOCK, "the original is kept");
    assert.ok(!readdirSync(join(st, "boot/firmware")).some((f) => f.includes(".new")), "no temp file left behind");
    assert.match(r.stdout, /\+ sync\n(.*\n)*?\+ sync/, "synced before and after the rename");
    assert.match(r.stdout, /REBOOT REQUIRED: the onboard controller goes away and the USB adapter becomes hci0 at the next boot \(sudo reboot\)/);
    assert.doesNotMatch(r.stdout, /restart bluetooth\.service|restart crow-kiosk-cage\.service/, "no restart dance before the reboot");
    assert.match(readFileSync(join(st, "etc/crow-kiosk/setup.env"), "utf8"), /^USB_BT=1$/m);
    assert.equal(readFileSync(join(st, "var/lib/systemd/rfkill/platform-3f980000.usb-usb-0:1.2:1.0:bluetooth"), "utf8"), "0\n", "the saved soft-block is cleared");
    assert.equal(readFileSync(join(st, "var/lib/systemd/rfkill/platform-3f300000.mmcnr:wlan"), "utf8"), "1\n", "Wi-Fi state untouched");
    assert.match(r.stdout, /\+ rm -f \/var\/lib\/crow-kiosk\/bt-serdev/, "the stale serdev record goes");
    assert.equal(readFileSync(join(st, "var/lib/crow-kiosk/bt-controller"), "utf8"), `bus=usb\nid=1-1.2\naddr=${USBBT}\n`);
    assert.ok(existsSync(join(st, "usr/local/lib/crow-kiosk/bt_controllers.py")), "bt-recover's helper is installed");
    const stop = r.stdout.indexOf("+ systemctl stop crow-kiosk-bt-recover.path");
    const boot = r.stdout.indexOf("wrote     /boot/firmware/config.txt");
    const start = r.stdout.indexOf("+ systemctl start crow-kiosk-bt-recover.path");
    assert.ok(stop > 0 && stop < boot && boot < start, "recovery is paused around the Bluetooth changes");

    r = run();                                        // remembered; nothing to rewrite; the reboot is still due
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(cfg, "utf8"), BOOT_STOCK + BOOT_MARKED);
    assert.doesNotMatch(r.stdout, /wrote {5}\/boot/);
    assert.match(r.stdout, /REBOOT REQUIRED/);

    r = run("--repair-speaker");                      // refused at argument time while the reboot is pending
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /reboot first, then re-run with --repair-speaker/);
    assert.doesNotMatch(r.stdout, /== files/, "refused before anything is written");

    r = run("--no-usb-bt");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(cfg, "utf8"), BOOT_STOCK, "only the marked pair is removed");
    assert.equal(readFileSync(cfg + ".crow-kiosk.orig", "utf8"), BOOT_STOCK);
    assert.match(r.stdout, /REBOOT REQUIRED: the onboard Bluetooth controller comes back at the next boot/);
    assert.match(readFileSync(join(st, "etc/crow-kiosk/setup.env"), "utf8"), /^USB_BT=0$/m);
    r = run();
    assert.doesNotMatch(r.stdout, /REBOOT REQUIRED|wrote {5}\/boot/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--usb-bt refuses without a USB Bluetooth adapter, with miniuart-bt, or without /boot/firmware/config.txt", (t) => {
  if (!have("python3")) return t.skip("python3 not available");
  for (const [opts, why] of [[{ usb: false }, /no USB Bluetooth adapter.*--no-usb-bt/s],
    [{ boot: BOOT_STOCK + "dtoverlay=miniuart-bt\n" }, /miniuart-bt/], [{ boot: null }, /\/boot\/firmware\/config\.txt/]]) {
    const dir = mkdtempSync(join(tmpdir(), "kiosk-usbbt-"));
    try {
      piRoot(dir, opts);
      const r = spawnSync("bash", [join(K, "pi-setup.sh"), "--crow-url", ORIGIN, "--usb-bt", "--dry-run", dir], { encoding: "utf8", env: { ...process.env, SUDO_USER: "alex" } });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, why);
      assert.ok(!existsSync(join(dir, "etc")), "nothing written");
      if (opts.boot !== null) assert.equal(readFileSync(join(dir, "boot/firmware/config.txt"), "utf8"), opts.boot ?? BOOT_STOCK);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("--usb-bt disables hciuart.service only where it exists (it is gone on trixie)", (t) => {
  if (!have("python3")) return t.skip("python3 not available");
  for (const present of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), "kiosk-usbbt-"));
    try {
      const st = join(dir, "st"), bin = join(dir, "bin");
      piRoot(st);
      mkdirSync(bin);
      writeFileSync(join(bin, "systemctl"), `#!/bin/bash\n[ "$1 $2" = "cat hciuart.service" ] && exit ${present ? 0 : 1}\nexit 1\n`, { mode: 0o755 });
      const r = spawnSync("bash", [join(K, "pi-setup.sh"), "--crow-url", ORIGIN, "--usb-bt", "--dry-run", st], { encoding: "utf8", env: { ...process.env, SUDO_USER: "alex", PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      if (present) assert.match(r.stdout, /\+ systemctl disable hciuart\.service/);
      else assert.doesNotMatch(r.stdout, /hciuart/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("pi-setup diagnosis: a speaker bond held by the onboard controller while the USB adapter is in use", (t) => {
  if (!have("python3")) return t.skip("python3 not available");
  const dir = mkdtempSync(join(tmpdir(), "kiosk-diag-"));
  try {
    const st = join(dir, "st"), bin = join(dir, "bin");
    piRoot(st, { boot: BOOT_STOCK });
    mkdirSync(join(st, "var/lib/bluetooth", ONBOARD, SPEAKER), { recursive: true });
    mkdirSync(join(st, "var/lib/bluetooth", USBBT), { recursive: true });
    const env = { ...process.env, SUDO_USER: "alex", ...fakeBt(bin) };
    const r = spawnSync("bash", [join(K, "pi-setup.sh"), "--crow-url", ORIGIN, "--bt-sink", SPEAKER, "--dry-run", st], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`warning: the speaker's pairing is held by ${ONBOARD} \\(onboard, hci0\\) but Bluetooth uses ${USBBT} \\(USB, hci1\\)\\.`));
    assert.match(r.stdout, /keep the USB adapter: re-run with --usb-bt, reboot, then --repair-speaker \(clear the speaker's list and put it in pairing mode first\); or unplug the adapter and reboot\./);
    assert.ok(existsSync(join(st, "var/lib/bluetooth", ONBOARD, SPEAKER)), "the stale bond is never removed");
    assert.doesNotMatch(r.stdout, /REBOOT REQUIRED/, "without --usb-bt config.txt is not touched");
    assert.equal(readFileSync(join(st, "boot/firmware/config.txt"), "utf8"), BOOT_STOCK);

    // the speaker bonded on the controller in use: no warning
    mkdirSync(join(st, "var/lib/bluetooth", USBBT, SPEAKER), { recursive: true });
    const ok = spawnSync("bash", [join(K, "pi-setup.sh"), "--dry-run", st], { encoding: "utf8", env });
    assert.equal(ok.status, 0, ok.stderr);
    assert.doesNotMatch(ok.stdout, /warning: .*(pairing|paired)/);
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
    fake("btmgmt", "exit 0");                        // no controller list: the serdev record path (pre-USB installs)
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

// bt-recover with a USB adapter (hci1, port 1-1.2) as the default controller and the onboard hci0 unmanaged.
const btRecoverUsb = (dir, { cls = "e0", driver = "btusb", port = "1-1.2", listed = true, record = false, usbreset = true } = {}) => {
  const root = join(dir, "root"), bin = join(dir, "bin"), log = join(dir, "calls");
  const usbDev = join(root, "sys/devices/platform/soc/3f980000.usb/usb1", port === "1-1" ? "1-1" : "1-1/" + port);
  const intf = join(usbDev, `${port}:1.0`);
  mkdirSync(intf, { recursive: true }); mkdirSync(join(root, "sys/bus/usb/drivers", driver), { recursive: true });
  symlinkSync(join(root, "sys/bus/usb/drivers", driver), join(intf, "driver"));
  writeFileSync(join(usbDev, "bDeviceClass"), cls + "\n"); writeFileSync(join(usbDev, "busnum"), "1\n"); writeFileSync(join(usbDev, "devnum"), "5\n");
  mkdirSync(join(root, "sys/bus/usb/devices"), { recursive: true }); symlinkSync(usbDev, join(root, "sys/bus/usb/devices", port));
  mkdirSync(join(root, "sys/class/bluetooth/hci1"), { recursive: true }); symlinkSync(intf, join(root, "sys/class/bluetooth/hci1/device"));
  mkdirSync(join(root, SERIAL_DEV), { recursive: true }); mkdirSync(join(root, "sys/class/bluetooth/hci0"), { recursive: true });
  symlinkSync(join(root, SERIAL_DEV), join(root, "sys/class/bluetooth/hci0/device"));
  if (record) { mkdirSync(join(root, "var/lib/crow-kiosk"), { recursive: true }); writeFileSync(join(root, "var/lib/crow-kiosk/bt-controller"), `bus=usb\nid=${port}\naddr=${USBBT}\n`); }
  mkdirSync(bin);
  const fake = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  fake("journalctl", `[ -f "${dir}/fault" ] && cat "${dir}/fault"; exit 0`);
  fake("bluetoothctl", `case "$1" in
  list) ${listed ? `echo "Controller ${USBBT} kiosk [default]"` : ":"} ;;
  show) [ -f "${dir}/powered" ] && printf '\\tPowered: yes\\n' ;;
esac; exit 0`);
  fake("btmgmt", listed ? `printf 'Index list with 1 item\\nhci1:\\tPrimary controller\\n\\taddr ${USBBT} version 10 manufacturer 93 class 0x000000\\n'` : `echo "Index list with 0 items"`);
  if (usbreset) fake("usbreset", `touch "${dir}/powered"; exit 0`);
  fake("systemctl", "exit 0"); fake("runuser", "exit 0"); fake("logger", "exit 0"); fake("id", "echo 1001"); fake("sleep", "exit 0");
  // never the host's own usbreset: the fake, or a path that does not exist
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CROW_KIOSK_TEST_ROOT: root, CROW_KIOSK_BT_WAIT: "2", CROW_KIOSK_USBRESET: join(bin, "usbreset") };
  return {
    run: () => spawnSync("bash", [join(K, "bt-recover.sh")], { encoding: "utf8", env }),
    state: () => readFileSync(join(root, "run/crow-kiosk/bt-recover.state"), "utf8").split(" ")[0],
    calls: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
    fault: (hci) => writeFileSync(join(dir, "fault"), `Oct 18 kernel: Bluetooth: ${hci}: command 0x0405 tx timeout\n`),
  };
};

test("bt-recover.sh with a USB adapter: resets that adapter's port only, re-finds it by address, then bluetoothd + WirePlumber", (t) => {
  if (!have("python3")) return t.skip("python3 not available");
  const dir = mkdtempSync(join(tmpdir(), "kiosk-btrec-usb-"));
  try {
    const b = btRecoverUsb(dir);
    b.fault("hci1");
    const r = b.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(b.state(), "ok", r.stdout);
    const c = b.calls();
    assert.match(c, /^usbreset 001\/005$/m, "the adapter's own bus/device number, never a hub or the webcam");
    assert.match(c, new RegExp(`^bluetoothctl show ${USBBT}$`, "m"), "found again by its address");
    assert.ok(c.indexOf("usbreset") < c.indexOf("systemctl restart bluetooth.service"));
    assert.ok(c.indexOf("systemctl restart bluetooth.service") < c.indexOf("runuser -u kiosk"));
    assert.doesNotMatch(c, /bluetoothctl (remove|pair|trust)/, "recovery never re-pairs");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bt-recover.sh with a USB adapter: errors from another controller are no evidence", (t) => {
  if (!have("python3")) return t.skip("python3 not available");
  const dir = mkdtempSync(join(tmpdir(), "kiosk-btrec-usb-"));
  try {
    const b = btRecoverUsb(dir);
    b.fault("hci0");                                 // the unused onboard controller
    assert.equal(b.run().status, 0);
    assert.equal(b.state(), "no_fault");
    assert.doesNotMatch(b.calls(), /usbreset/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bt-recover.sh with a USB adapter: BlueZ lost it, so the controller record finds the port", (t) => {
  if (!have("python3")) return t.skip("python3 not available");
  const dir = mkdtempSync(join(tmpdir(), "kiosk-btrec-usb-"));
  try {
    const b = btRecoverUsb(dir, { listed: false, record: true });
    b.fault("hci1");
    assert.equal(b.run().status, 0);
    assert.equal(b.state(), "ok");
    assert.match(b.calls(), /^usbreset 001\/005$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bt-recover.sh with a USB adapter: a hub, a device without btusb, a root-level port or no usbreset is never reset", (t) => {
  if (!have("python3")) return t.skip("python3 not available");
  for (const [opts, what] of [[{ cls: "09" }, "hub class"], [{ driver: "uvcvideo" }, "not btusb"], [{ port: "1-1" }, "root-level port"], [{ usbreset: false }, "no usbreset"]]) {
    const dir = mkdtempSync(join(tmpdir(), "kiosk-btrec-usb-"));
    try {
      const b = btRecoverUsb(dir, opts);
      b.fault("hci1");
      assert.equal(b.run().status, 0, what);
      assert.equal(b.state(), "needs_restart", what);
      assert.doesNotMatch(b.calls(), /^usbreset/m, what);
      assert.doesNotMatch(b.calls(), /restart bluetooth\.service/, what);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("kiosk-launch.sh waits (bounded) for the speaker's sink before starting Chromium", () => {
  const launch = readFileSync(join(K, "kiosk-launch.sh"), "utf8");
  const wait = launch.indexOf("pactl list short sinks");
  assert.ok(wait > 0 && wait < launch.indexOf("exec /usr/bin/chromium"));
  assert.match(launch, /for _ in \$\(seq 1 20\)/);
});

test("pi-setup.sh --help prints the whole usage block (its sed range follows the header)", () => {
  const r = spawnSync("bash", [join(K, "pi-setup.sh"), "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Crow kiosk: set up a Raspberry Pi/);
  assert.match(r.stdout, /--usb-bt \| --no-usb-bt/);
  assert.match(r.stdout, /\n {2}-h, --help\n$/, "ends at -h, --help");
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
      ["--crow-url", ORIGIN, "--wake-threads", "8"], ["--crow-url", ORIGIN, "--wake-step", "0"], ["--crow-url", ORIGIN, "--usb-bt"]]) {
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
