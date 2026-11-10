/**
 * `createStderrPrefixer` and `AddonStdioTransport` (scripts/addon-sandbox/transport.mjs).
 *
 * The prefixer is judged on what it emits: partial lines carried across chunks,
 * the trailing `\r` of a CRLF line, one over-long line cut at the cap once, and
 * a per-second line budget whose excess is one summary line. The transport runs
 * a real child; its `stdioExtra` placement is judged on what that child can
 * read, and on the host copy of each fd being closed by the time `start()`
 * settles.
 *
 * Scratch dirs under mkdtemp, real children, no network.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fstatSync, mkdtempSync, openSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AddonStdioTransport, createStderrPrefixer } from "../scripts/addon-sandbox/transport.mjs";

const T = realpathSync(mkdtempSync(join(tmpdir(), "addon-transport-")));
after(() => rmSync(T, { recursive: true, force: true }));

/** Resolve once `check()` is true, or fail after `ms`. */
function waitFor(check, ms = 5000, what = "condition") {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false;
      try { ok = check(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting for " + what));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("the prefixer carries a partial line across chunks and strips CRLF", () => {
  const logged = [];
  const p = createStderrPrefixer({ id: "x", log: (l) => logged.push(l) });
  p.write("a\nb");
  p.write("c\n");
  assert.deepEqual(logged, ["[addon:x] a", "[addon:x] bc"]);
  p.write("crlf\r\n");
  assert.deepEqual(logged.at(-1), "[addon:x] crlf");
  assert.equal(logged.at(-1).includes("\r"), false);

  p.write("tail");
  assert.deepEqual(p.lines(), ["a", "bc", "crlf"]);
  p.end();
  assert.equal(logged.at(-1), "[addon:x] tail");
  assert.deepEqual(p.lines(), ["a", "bc", "crlf", "tail"]);
  assert.equal(p.dropped(), 0);
});

test("a 1 MiB line is emitted once, cut at the cap, and the next line is intact", () => {
  const logged = [];
  const p = createStderrPrefixer({ id: "x", log: (l) => logged.push(l), maxLineBytes: 4096 });
  const big = Buffer.from("a".repeat(1024 * 1024) + "\nok\n");
  for (let i = 0; i < big.length; i += 64 * 1024) p.write(big.subarray(i, i + 64 * 1024));
  p.end();
  assert.equal(logged.length, 2);
  assert.equal(logged[0], "[addon:x] " + "a".repeat(4096) + " …[truncated]");
  assert.equal(logged[1], "[addon:x] ok");
  // The carried partial line was only ever the capped line, not the 1 MiB.
  assert.deepEqual(p.lines(), ["a".repeat(4096) + " …[truncated]", "ok"]);
  assert.equal(p.dropped(), 0);
});

test("the rate limit logs 200 lines, one summary, and keeps the last 50", () => {
  const logged = [];
  let clock = 1_000_000;
  const p = createStderrPrefixer({ id: "x", log: (l) => logged.push(l), now: () => clock });
  for (let i = 0; i < 250; i++) p.write("line-" + i + "\n");
  assert.equal(logged.length, 200);
  assert.equal(logged[0], "[addon:x] line-0");
  assert.equal(logged.at(-1), "[addon:x] line-199");
  assert.equal(p.dropped(), 50);

  // The next window starts: the drop is reported once, then the line is logged.
  clock += 1000;
  p.write("after\n");
  assert.equal(logged.length, 202);
  assert.equal(logged[200], "[addon:x] 50 stderr lines dropped (rate limit)");
  assert.equal(logged[201], "[addon:x] after");
  assert.equal(p.dropped(), 50, "the total stays counted");

  const kept = p.lines();
  assert.equal(kept.length, 50);
  assert.equal(kept.at(-1), "after");
  assert.equal(kept.includes("line-199"), true);

  // end() reports a window's leftovers too, and flushes a partial line.
  clock += 1000;
  for (let i = 0; i < 210; i++) p.write("more-" + i + "\n");
  p.write("unterminated");
  p.end();
  assert.equal(logged.at(-1), "[addon:x] 11 stderr lines dropped (rate limit)");
  assert.equal(p.dropped(), 61);
});

// ---- the transport -------------------------------------------------------

/** A tiny MCP-like child: answers one JSON line per request line, greets on stderr. */
const ECHO_SCRIPT = [
  'process.stderr.write("hello\\n");',
  'let buf = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (d) => {',
  '  buf += d;',
  '  let i;',
  '  while ((i = buf.indexOf("\\n")) >= 0) {',
  '    const line = buf.slice(0, i);',
  '    buf = buf.slice(i + 1);',
  '    const msg = JSON.parse(line);',
  '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\\n");',
  '  }',
  '});',
].join("\n");

test("a real child: one answer over stdio, its stderr prefixed, its exit before onclose", async () => {
  const logged = [];
  const events = [];
  const messages = [];
  let stderrText = "";
  const t = new AddonStdioTransport({
    id: "t",
    command: process.execPath,
    args: ["-e", ECHO_SCRIPT],
    env: { ...process.env },
    log: (l) => logged.push(l),
    onExit: () => events.push("exit"),
  });
  t.onmessage = (m) => messages.push(m);
  t.onclose = () => events.push("close");
  t.stderr.on("data", (chunk) => { stderrText += chunk.toString("utf8"); });

  await t.start();
  assert.equal(typeof t.pid, "number");
  await t.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  await waitFor(() => messages.length === 1, 5000, "the child's answer");
  assert.deepEqual(messages[0], { jsonrpc: "2.0", id: 1, result: { ok: true } });

  await waitFor(() => logged.includes("[addon:t] hello"), 5000, "the stderr line");
  assert.equal(stderrText.includes("hello"), true);
  assert.equal(t.stderrLines().includes("hello"), true);

  await t.close();
  assert.equal(t.pid, null);
  assert.deepEqual(events, ["exit", "close"]);
  assert.equal(t.stderrLines().filter((l) => l === "hello").length, 1);
});

test("stdioExtra places an fd, a write pipe and a read pipe where the child looks", async () => {
  const scratch = join(T, "payload.bin");
  writeFileSync(scratch, "0123456789");
  const fd = openSync(scratch, "r");
  const before = statSync(scratch);
  const dataEntry = { childFd: 5, fd };
  const tokenEntry = { childFd: 6, pipe: "write", data: "TOKEN" };
  const infoEntry = { childFd: 4, pipe: "read", role: "info" };

  const code = [
    'const fs = require("node:fs");',
    'const token = fs.readFileSync(6, "utf8");',
    'fs.writeSync(4, token + "|" + fs.fstatSync(5).size);',
  ].join("\n");
  const t = new AddonStdioTransport({
    id: "extra",
    command: process.execPath,
    args: ["-e", code],
    env: { ...process.env },
    log: () => {},
    stdioExtra: [dataEntry, tokenEntry, infoEntry],
  });
  await t.start();
  assert.equal(dataEntry.fd, null, "the host copy of the bind fd is closed by start()");
  // The number may be reused by anything; it must not still be this file.
  let reused = null;
  try { reused = fstatSync(fd); } catch { reused = null; }
  if (reused) assert.notEqual(`${reused.dev}:${reused.ino}`, `${before.dev}:${before.ino}`);

  let seen = "";
  t.extraStreams.info.on("data", (chunk) => { seen += chunk.toString("utf8"); });
  await waitFor(() => seen.length > 0, 5000, "the info pipe");
  assert.equal(seen, "TOKEN|10");
  await t.close();
});

test("a child that exits by itself closes the transport once", async () => {
  const events = [];
  const t = new AddonStdioTransport({
    id: "gone",
    command: process.execPath,
    args: ["-e", "process.exit(3)"],
    env: { ...process.env },
    log: () => {},
    onExit: () => events.push("exit"),
  });
  t.onclose = () => events.push("close");
  await t.start();
  await waitFor(() => events.includes("close"), 5000, "the child to close");
  assert.deepEqual(events, ["exit", "close"]);
  const started = Date.now();
  await t.close();
  assert.ok(Date.now() - started < 1000, "close() on an exited child returns at once");
  assert.deepEqual(events, ["exit", "close"], "and does not close twice");
});