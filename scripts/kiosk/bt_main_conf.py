#!/usr/bin/env python3
"""stdin: /etc/bluetooth/main.conf (may be empty) -> stdout: the same file with
  ControllerMode = bredr   in [General]  (A2DP needs classic Bluetooth; LE reconnects failed), and
  AutoEnable=true          in [Policy]   (BlueZ powers every controller it manages, a USB adapter too).
Other lines are kept as they are; an existing (or commented) line for the key in its section is replaced
in place; a missing section is added ([General] first in the file, [Policy] at the end). Idempotent."""

import re
import sys

SETTINGS = (
    ("General", "ControllerMode", "ControllerMode = bredr", "start"),
    ("Policy", "AutoEnable", "AutoEnable=true", "end"),
)


def _set(lines, section, key, want, new_at):
    out, current, done, seen = [], None, False, False
    key_re = re.compile(rf"^\s*#?\s*{key}\s*=")
    for line in lines:
        m = re.match(r"^\s*\[([^\]]+)\]\s*$", line)
        if m:
            if current == section and not done:
                while out and out[-1] == "":
                    out.pop()
                out.append(want)
                out.append("")
                done = True
            current = m.group(1)
            seen = seen or current == section
            out.append(line)
            continue
        if current == section and key_re.match(line):
            if not done:
                out.append(want)
                done = True
            continue
        out.append(line)
    if not done:
        if seen:
            while out and out[-1] == "":
                out.pop()
            out.append(want)
        elif new_at == "start":
            out = [f"[{section}]", want] + ([""] if out else []) + out
        else:
            while out and out[-1] == "":
                out.pop()
            out = out + ([""] if out else []) + [f"[{section}]", want]
    return out


def fix(text):
    lines = text.splitlines()
    for section, key, want, new_at in SETTINGS:
        lines = _set(lines, section, key, want, new_at)
    while lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    sys.stdout.write(fix(sys.stdin.read()))
