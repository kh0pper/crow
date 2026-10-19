#!/usr/bin/env python3
"""Raspberry Pi /boot/firmware/config.txt: turn the onboard Bluetooth controller off (pi-setup --usb-bt)
or back on (--no-usb-bt). Pure text in, text out:

  boot_config.py enable|disable < config.txt > new   (exit 3 from enable: dtoverlay=miniuart-bt present)
  boot_config.py marked < config.txt                  (exit 0 if our marked pair is there, else 1)

enable appends two lines, a marker comment and `dtoverlay=disable-bt`, so they apply to every board
(an `[all]` header is added first when the file ends inside a conditional section such as `[pi5]`). It
changes nothing when an uncommented disable-bt already applies to all boards. disable removes only our
marked pair (an `[all]` header it added stays: harmless, and it keeps enable/disable idempotent). Every
other line, its order and the file's line endings are kept."""

import re
import sys

MARK = "# crow-kiosk: onboard Bluetooth off (pi-setup --usb-bt)"
LINE = "dtoverlay=disable-bt"
_HEADER = re.compile(r"^\s*\[([^\]]*)\]\s*$")
_DISABLE = re.compile(r"^\s*dtoverlay\s*=\s*(pi3-)?disable-bt\s*(#.*)?$")
_MINIUART = re.compile(r"^\s*dtoverlay\s*=\s*(pi3-)?miniuart-bt\b")


def _split(text):
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.split(nl)
    if lines and lines[-1] == "":
        lines.pop()  # the final newline (or an empty file)
    return lines, nl


def _join(lines, nl):
    return "".join(line + nl for line in lines)


def _applies_to_all(lines):
    """True when an uncommented disable-bt is in effect for every board."""
    in_all = True
    for line in lines:
        m = _HEADER.match(line)
        if m:
            in_all = m.group(1).strip().lower() == "all"
        elif in_all and _DISABLE.match(line):
            return True
    return False


def _ends_in_all(lines):
    for line in reversed(lines):
        m = _HEADER.match(line)
        if m:
            return m.group(1).strip().lower() == "all"
    return True


def has_miniuart(text):
    return any(_MINIUART.match(line) for line in _split(text)[0])


def marked(text):
    lines = _split(text)[0]
    return any(lines[i] == MARK and lines[i + 1] == LINE for i in range(len(lines) - 1))


def enable(text):
    lines, nl = _split(text)
    if _applies_to_all(lines):
        return text
    if not _ends_in_all(lines):
        lines.append("[all]")
    return _join(lines + [MARK, LINE], nl)


def disable(text):
    lines, nl = _split(text)
    out, i = [], 0
    while i < len(lines):
        if lines[i] == MARK and i + 1 < len(lines) and lines[i + 1] == LINE:
            i += 2
            continue
        out.append(lines[i])
        i += 1
    if out == lines:
        return text
    return _join(out, nl)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) == 2 else ""
    src = sys.stdin.read()
    if cmd == "enable":
        if has_miniuart(src):
            sys.stderr.write(
                "dtoverlay=miniuart-bt is set: the onboard controller is in use on the mini UART\n"
            )
            sys.exit(3)
        sys.stdout.write(enable(src))
    elif cmd == "disable":
        sys.stdout.write(disable(src))
    elif cmd == "marked":
        sys.exit(0 if marked(src) else 1)
    else:
        sys.stderr.write("usage: boot_config.py enable|disable|marked < config.txt\n")
        sys.exit(2)
