#!/usr/bin/env python3
"""Read one key from a Crow bundle .env without any shell evaluation.

Decodes exactly what Crow's installer writes (servers/gateway/bundle-env-codec.js):
bare values, 'single-quoted' (backslash-quote -> quote) and "double-quoted"
(escapes for backslash, double quote, $, n, t, r) values, an optional `export `
prefix and a trailing ` #comment` on bare values. Last occurrence wins.
Usage: envfile.py get <file> <KEY>   -> prints the value (no newline); exit 0 if absent.
"""
import re
import sys

LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")
DQ = {"\\": "\\", '"': '"', "$": "$", "n": "\n", "t": "\t", "r": "\r"}


def decode(raw):
    s = raw.lstrip()
    if s.startswith("'"):
        out, i = [], 1
        while i < len(s):
            c = s[i]
            if c == "\\" and i + 1 < len(s) and s[i + 1] == "'":
                out.append("'")
                i += 2
                continue
            if c == "'":
                return "".join(out)
            out.append(c)
            i += 1
        return s
    if s.startswith('"'):
        out, i = [], 1
        while i < len(s):
            c = s[i]
            if c == "\\" and i + 1 < len(s):
                n = s[i + 1]
                if n in DQ:
                    out.append(DQ[n])
                    i += 2
                    continue
                out.append(c)
                i += 1
                continue
            if c == '"':
                return "".join(out)
            out.append(c)
            i += 1
        return s
    return re.split(r"\s+#", s, maxsplit=1)[0].strip()


def get(path, key):
    val = ""
    with open(path, encoding="utf-8") as f:
        for line in f.read().split("\n"):
            m = LINE.match(line.rstrip("\r"))
            if m and m.group(1) == key:
                val = decode(m.group(2))
    return val


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] != "get":
        sys.stderr.write("usage: envfile.py get <file> <KEY>\n")
        sys.exit(2)
    sys.stdout.write(get(sys.argv[2], sys.argv[3]))
