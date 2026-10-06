"""Pi hardware glue: backlight (sysfs), touch (evdev), Bluetooth sink (bluetoothctl)."""

import glob
import os
import re
import struct

# ---- backlight -------------------------------------------------------------------------------


class Backlight:
    """/sys/class/backlight/<dev>: bl_power 0 = on, 4 = off (FB_BLANK_POWERDOWN).

    bl_power is root-only by default; the setup script's udev rule gives the video group write
    access. If bl_power cannot be written, brightness 0 / the previous brightness is the fallback.
    read() takes the real state from sysfs at start, so an agent restarted while the screen was dark
    knows it is dark.
    """

    def __init__(self, base=None):
        if base is None:
            found = sorted(glob.glob("/sys/class/backlight/*"))
            base = found[0] if found else None
        self.base = base
        self.on = True
        self.saved_brightness = None

    def available(self):
        return bool(self.base) and os.path.isdir(self.base)

    def _read(self, name):
        with open(os.path.join(self.base, name)) as f:
            return int(f.read().strip() or 0)

    def _write(self, name, value):
        with open(os.path.join(self.base, name), "w") as f:
            f.write(str(value))

    def read(self):
        if not self.available():
            return self.on
        try:
            self.on = self._read("bl_power") == 0 and self._read("brightness") > 0
        except (OSError, ValueError):
            pass
        return self.on

    def set(self, on):
        if not self.available():
            return False
        try:
            self._write("bl_power", 0 if on else 4)
        except OSError:
            if on:
                top = self.saved_brightness or self._read("max_brightness") or 255
                self._write("brightness", top)
            else:
                cur = self._read("brightness")
                if cur > 0:
                    self.saved_brightness = cur
                self._write("brightness", 0)
        self.on = on
        return True


# ---- touch -----------------------------------------------------------------------------------

EV_KEY, EV_ABS = 0x01, 0x03
BTN_TOUCH = 0x14A
ABS_MT_TRACKING_ID = 0x39
EVENT = struct.Struct(
    "llHHi"
)  # struct input_event on 64-bit Linux: timeval, type, code, value


def find_input_device(name_fragment, devices_text=None):
    """Return /dev/input/eventN for the first device whose name contains name_fragment."""
    if devices_text is None:
        with open("/proc/bus/input/devices") as f:
            devices_text = f.read()
    for block in devices_text.strip().split("\n\n"):
        m_name = re.search(r'^N: Name="([^"]*)"', block, re.M)
        m_ev = re.search(r"^H: Handlers=.*\b(event\d+)\b", block, re.M)
        if m_name and m_ev and name_fragment.lower() in m_name.group(1).lower():
            return f"/dev/input/{m_ev.group(1)}"
    return None


def is_touch_down(etype, code, value):
    """A finger landing: BTN_TOUCH press, or a new multitouch contact (tracking id >= 0)."""
    return (etype == EV_KEY and code == BTN_TOUCH and value == 1) or (
        etype == EV_ABS and code == ABS_MT_TRACKING_ID and value >= 0
    )


def read_touch_downs(path, on_down, stop):
    """Blocking reader (run in a thread). Calls on_down() for every finger landing until stop() is true."""
    with open(path, "rb", buffering=0) as f:
        while not stop():
            data = f.read(EVENT.size * 16)
            if not data:
                return
            for off in range(0, len(data) - EVENT.size + 1, EVENT.size):
                _s, _us, etype, code, value = EVENT.unpack_from(data, off)
                if is_touch_down(etype, code, value):
                    on_down()


# ---- Bluetooth sink --------------------------------------------------------------------------

MAC_RE = re.compile(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$")


def valid_mac(mac):
    return bool(mac) and bool(MAC_RE.match(mac.upper()))


def parse_bt_info(text):
    """Fields we use from `bluetoothctl info <mac>`."""

    def yes(field):
        m = re.search(rf"^\s*{field}:\s*(yes|no)\s*$", text, re.M)
        return bool(m) and m.group(1) == "yes"

    return {
        "paired": yes("Paired"),
        "trusted": yes("Trusted"),
        "connected": yes("Connected"),
    }


class ReconnectBackoff:
    """30 s between attempts while the sink is away, growing to 5 min; reset once connected."""

    def __init__(self, first_s=30, max_s=300):
        self.first_s, self.max_s = first_s, max_s
        self.delay = first_s

    def connected(self):
        self.delay = self.first_s
        return self.first_s

    def failed(self):
        d = self.delay
        self.delay = min(self.max_s, self.delay * 2)
        return d
