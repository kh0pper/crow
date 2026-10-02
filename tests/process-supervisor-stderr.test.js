// tests/process-supervisor-stderr.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { superviseProcess } from "../servers/gateway/process-supervisor.js";

function fakeSpawn() {
  const children = [];
  const spawn = () => {
    const c = new EventEmitter();
    c.pid = 4242 + children.length;
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.kill = () => c.emit("exit", null, "SIGTERM");
    children.push(c);
    return c;
  };
  return { spawn, children };
}

test("stderrTail keeps the last N lines, split on newlines, across chunk boundaries", async () => {
  const { spawn, children } = fakeSpawn();
  const h = superviseProcess({ key: "t1", command: "x", spawn, stderrTailLines: 3, maxRestarts: 0 });
  children[0].stderr.write("one\ntw");
  children[0].stderr.write("o\nthree\nfour\n");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.stderrTail(), ["two", "three", "four"]);
});

test("the tail survives a restart (the cause of a crash loop stays visible)", async () => {
  const { spawn, children } = fakeSpawn();
  const h = superviseProcess({ key: "t2", command: "x", spawn, stderrTailLines: 5, maxRestarts: 1, backoffMs: () => 0, setTimeoutFn: (fn) => { fn(); return 0; } });
  children[0].stderr.write("load failed: out of memory\n");
  await new Promise((r) => setImmediate(r));
  children[0].emit("exit", 1, null);
  children[1].stderr.write("load failed again\n");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.stderrTail(), ["load failed: out of memory", "load failed again"]);
});
