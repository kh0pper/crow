#!/usr/bin/env python3
"""stdin: /etc/bluetooth/main.conf (may be empty) -> stdout: the same file with ControllerMode = bredr
in [General]. Other lines are kept as they are; an existing (or commented) ControllerMode line in
[General] is replaced in place. Idempotent."""
import re
import sys

WANT = "ControllerMode = bredr"


def fix(text):
    lines = text.splitlines()
    out, section, done, general_at = [], None, False, None
    for line in lines:
        m = re.match(r"^\s*\[([^\]]+)\]\s*$", line)
        if m:
            if section == "General" and not done:
                out.append(WANT)
                done = True
            section = m.group(1)
            if section == "General":
                general_at = len(out)
            out.append(line)
            continue
        if section == "General" and re.match(r"^\s*#?\s*ControllerMode\s*=", line):
            if not done:
                out.append(WANT)
                done = True
            continue
        out.append(line)
    if not done:
        if general_at is None:
            out = ["[General]", WANT] + ([""] if out else []) + out
        else:
            out.append(WANT)
    while out and out[-1] == "":
        out.pop()
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    sys.stdout.write(fix(sys.stdin.read()))
