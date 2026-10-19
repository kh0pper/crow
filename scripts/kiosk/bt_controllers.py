#!/usr/bin/env python3
"""Which Bluetooth controller is in use, which bus it sits on, and who holds the speaker's pairing.

Used by pi-setup (diagnosis, --usb-bt guard, the controller record) and by bt-recover.sh (installed next
to it). Facts come from three places, never from guesses:
  - `bluetoothctl list`  the controllers bluetoothd uses, and the [default] one (by address);
  - `btmgmt info`        address -> hciN for every controller the kernel's mgmt interface manages
                         (sysfs has no address file on the Pi's kernel);
  - sysfs                bus from `readlink -f /sys/class/bluetooth/hciN/device`
                         (.../usb1/1-1/1-1.2/1-1.2:1.0 = USB port 1-1.2; .../serial0/serial0-0 = the onboard
                         UART controller). BlueZ's Modalias is a DeviceID, not the bus: never used.
  - /var/lib/bluetooth/<controller>/<device>/ = a bond (BlueZ keeps one tree per controller address).

CLI (every text input is a file; /dev/null when unknown):
  bt_controllers.py usb-present|serial-present --root R             exit 0 yes, 1 no
  bt_controllers.py diagnose --root R --list F --mgmt F --show F [--sink MAC]
                                                 prints status=<s> then the message lines
  bt_controllers.py resolve --root R --list F --mgmt F [--record F]  prints hci= bus= id= addr=
  bt_controllers.py record --root R --list F --mgmt F               prints the bt-controller record
"""

import argparse
import glob
import os
import re
import sys

_MAC = r"[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}"
_USB_IF = re.compile(r"^(\d+-\d+(?:\.\d+)*):\d+\.\d+$")
_USB_DEV = re.compile(r"^\d+-\d+(?:\.\d+)*$")
_SERDEV = re.compile(r"^serial\d+-\d+$")
LABEL = {"usb": "USB", "serial": "onboard"}


def parse_mgmt(text):
    """`btmgmt info` -> {ADDR: "hciN"}."""
    out, hci = {}, None
    for line in (text or "").splitlines():
        m = re.match(r"^(hci\d+):\s", line)
        if m:
            hci = m.group(1)
            continue
        m = re.match(rf"^\s+addr ({_MAC})\b", line)
        if m and hci:
            out[m.group(1).upper()] = hci
    return out


def parse_list(text):
    """`bluetoothctl list` -> [(ADDR, is_default)]."""
    return [
        (m.group(1).upper(), m.group(2) is not None)
        for m in re.finditer(
            rf"^Controller ({_MAC})\b.*?(\[default\])?\s*$", text or "", re.M
        )
    ]


def default_of(list_text):
    ctrls = parse_list(list_text)
    for addr, is_default in ctrls:
        if is_default:
            return addr
    return ctrls[0][0] if len(ctrls) == 1 else None


def bus_of(root, hci):
    """("usb", "1-1.2") | ("serial", "serial0-0") | (None, None), from the hciN device link."""
    link = os.path.join(root, "sys/class/bluetooth", hci, "device")
    if not os.path.exists(link):
        return None, None
    parts = os.path.realpath(link).split(os.sep)
    for part in reversed(parts):
        if _SERDEV.match(part):
            return "serial", part
    if any(re.match(r"^usb\d+$", p) for p in parts):
        for part in reversed(parts):
            m = _USB_IF.match(part)
            if m:
                return "usb", m.group(1)
            if _USB_DEV.match(part):
                return "usb", part
    return None, None


def sys_controllers(root):
    """[(hciN, bus, id)] for every controller the kernel has (managed by BlueZ or not)."""
    out = []
    for path in sorted(glob.glob(os.path.join(root, "sys/class/bluetooth/hci*"))):
        hci = os.path.basename(path)
        bus, dev = bus_of(root, hci)
        out.append((hci, bus, dev))
    return out


def usb_present(root):
    return any(bus == "usb" for _, bus, _ in sys_controllers(root))


def serial_present(root):
    return any(bus == "serial" for _, bus, _ in sys_controllers(root))


def bond_holders(root, mac):
    mac = mac.upper()
    return sorted(
        os.path.basename(os.path.dirname(p))
        for p in glob.glob(os.path.join(root, "var/lib/bluetooth/*", mac))
        if os.path.isdir(p)
    )


def _describe(root, addr, mgmt):
    hci = mgmt.get(addr)
    if not hci:
        # not managed by BlueZ: name it only when exactly one kernel controller is unmanaged
        unmanaged = [h for h, _, _ in sys_controllers(root) if h not in mgmt.values()]
        hci = unmanaged[0] if len(unmanaged) == 1 else None
    if not hci:
        return f"{addr} (not present now)"
    bus, _ = bus_of(root, hci)
    return f"{addr} ({LABEL.get(bus, 'unknown bus')}, {hci})"


def diagnose(root, list_text, mgmt_text, show_text, sink):
    """status: ok | no_controller | bond_elsewhere | default_blocked | not_paired, with message lines."""
    mgmt = parse_mgmt(mgmt_text)
    default = default_of(list_text)
    if not default:
        return {
            "status": "no_controller",
            "message": [
                "warning: no Bluetooth controller is available (bluetoothctl lists none). With --usb-bt the onboard "
                "one is off: is the USB adapter plugged in? (--no-usb-bt and a reboot bring the onboard one back)"
            ],
        }
    used = _describe(root, default, mgmt)
    holders = bond_holders(root, sink) if sink else []
    if sink and default not in holders and holders and usb_present(root):
        return {
            "status": "bond_elsewhere",
            "message": [
                f"warning: the speaker's pairing is held by {_describe(root, holders[0], mgmt)} but Bluetooth uses {used}.",
                "   keep the USB adapter: re-run with --usb-bt, reboot, then --repair-speaker (clear the speaker's list "
                "and put it in pairing mode first); or unplug the adapter and reboot.",
            ],
        }
    if re.search(r"^\s*PowerState:\s*off-blocked\s*$", show_text or "", re.M):
        return {
            "status": "default_blocked",
            "message": [
                f"warning: the Bluetooth controller in use, {used}, is soft-blocked (rfkill). pi-setup unblocked "
                "Bluetooth and saved that for the next boot; if it stays blocked, check: rfkill list"
            ],
        }
    if sink and default not in holders:
        return {
            "status": "not_paired",
            "message": [
                f"warning: {sink.upper()} is not paired with the controller in use, {used}. Pair it with "
                "--repair-speaker (clear the speaker's paired list and put it in pairing mode first)."
            ],
        }
    return {"status": "ok", "message": []}


def _parse_record(text):
    rec = dict(line.split("=", 1) for line in (text or "").splitlines() if "=" in line)
    return {k: rec.get(k, "").strip() for k in ("bus", "id", "addr")}


def resolve(root, list_text, mgmt_text, record_text_in):
    """The controller in use: by the default address (bluetoothctl) -> hciN (btmgmt) -> bus (sysfs); when
    BlueZ has lost it (a hung controller), by the record pi-setup wrote, found again in sysfs by its device."""
    mgmt = parse_mgmt(mgmt_text)
    rec = _parse_record(record_text_in)
    addr = default_of(list_text) or rec["addr"].upper()
    hci = mgmt.get(addr, "") if addr else ""
    if hci:
        bus, dev = bus_of(root, hci)
        return {"hci": hci, "bus": bus or "", "id": dev or "", "addr": addr}
    if rec["bus"] and rec["id"]:
        for h, bus, dev in sys_controllers(root):
            if (bus, dev) == (rec["bus"], rec["id"]):
                hci = h
                break
        return {"hci": hci, "bus": rec["bus"], "id": rec["id"], "addr": addr}
    return {"hci": "", "bus": "", "id": "", "addr": addr or ""}


def record_text(r):
    return f"bus={r['bus']}\nid={r['id']}\naddr={r['addr']}\n"


def _read(path):
    if not path:
        return ""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "cmd",
        choices=["usb-present", "serial-present", "diagnose", "resolve", "record"],
    )
    ap.add_argument("--root", default="/")
    for opt in ("--list", "--mgmt", "--show", "--record"):
        ap.add_argument(opt, default="")
    ap.add_argument("--sink", default="")
    a = ap.parse_args(argv)
    if a.cmd == "usb-present":
        return 0 if usb_present(a.root) else 1
    if a.cmd == "serial-present":
        return 0 if serial_present(a.root) else 1
    if a.cmd == "diagnose":
        d = diagnose(a.root, _read(a.list), _read(a.mgmt), _read(a.show), a.sink)
        print(f"status={d['status']}")
        for line in d["message"]:
            print(line)
        return 0
    r = resolve(a.root, _read(a.list), _read(a.mgmt), _read(a.record))
    if a.cmd == "resolve":
        print(" ".join(f"{k}={r[k]}" for k in ("hci", "bus", "id", "addr")))
    elif r["bus"]:
        sys.stdout.write(record_text(r))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
