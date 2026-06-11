/**
 * Tests for servers/shared/http-timeout.js
 *
 * Spins up real node:http servers to exercise the timeout helpers end-to-end.
 * All servers use listen(0) so the OS picks a free port.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  connectTimeout,
  timeoutSignal,
  composeSignals,
  isTimeoutError,
} from "../servers/shared/http-timeout.js";

// ---------------------------------------------------------------------------
// Helper: create and start an http.Server, resolve with the bound port.
// ---------------------------------------------------------------------------
function startServer(handler) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      resolve({ srv, port: srv.address().port });
    });
    srv.on("error", reject);
  });
}

function stopServer(srv) {
  return new Promise((resolve, reject) =>
    srv.close(err => (err ? reject(err) : resolve()))
  );
}

// ---------------------------------------------------------------------------
// (a) connectTimeout aborts a fetch to a server that never responds
// ---------------------------------------------------------------------------
describe("connectTimeout — never-responding server", () => {
  let srv, port;

  before(async () => {
    // Server accepts the connection but never writes headers.
    ({ srv, port } = await startServer((_req, _res) => { /* silent */ }));
  });

  after(() => stopServer(srv));

  it("rejects with a TimeoutError within the timeout window", async () => {
    const t = connectTimeout(200);
    const start = Date.now();
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${port}/`, { signal: t.signal }),
      err => {
        assert.ok(isTimeoutError(err), `expected TimeoutError, got ${err?.name}: ${err?.message}`);
        return true;
      }
    );
    const elapsed = Date.now() - start;
    // Should fire around 200ms; give generous upper bound for slow CI.
    assert.ok(elapsed < 2000, `timeout fired too late (${elapsed}ms)`);
  });
});

// ---------------------------------------------------------------------------
// (b) disarm-on-headers: server flushes headers immediately, body is slow
// ---------------------------------------------------------------------------
describe("connectTimeout — disarm on headers lets slow body arrive", () => {
  let srv, port;

  before(async () => {
    // Send headers immediately; delay the body chunk.
    ({ srv, port } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.flushHeaders();
      setTimeout(() => {
        res.end("done");
      }, 400); // body arrives 400ms after headers (timeout is 200ms)
    }));
  });

  after(() => stopServer(srv));

  it("resolves and delivers the full body after disarm", async () => {
    const t = connectTimeout(200);
    // Disarm in the same statement as the await — timer cleared before
    // the 200ms deadline fires on the body window.
    const res = t.disarm(await fetch(`http://127.0.0.1:${port}/`, { signal: t.signal }));
    const text = await res.text();
    assert.equal(text, "done");
  });
});

// ---------------------------------------------------------------------------
// (c) timeoutSignal aborts a hung fetch
// ---------------------------------------------------------------------------
describe("timeoutSignal — aborts hung fetch", () => {
  let srv, port;

  before(async () => {
    ({ srv, port } = await startServer((_req, _res) => { /* silent */ }));
  });

  after(() => stopServer(srv));

  it("rejects with an abort/timeout error", async () => {
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${port}/`, { signal: timeoutSignal(150) }),
      err => {
        // undici surfaces AbortError (name="AbortError") wrapping a TimeoutError,
        // OR a DOMException with name="TimeoutError" depending on Node version.
        const ok =
          err?.name === "TimeoutError" ||
          err?.name === "AbortError" ||
          err?.cause?.name === "TimeoutError";
        assert.ok(ok, `expected timeout-related error, got name=${err?.name} cause=${err?.cause?.name}`);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// (d) composeSignals
// ---------------------------------------------------------------------------
describe("composeSignals", () => {
  it("aborting first source aborts composite", async () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    const composed = composeSignals(c1.signal, c2.signal);
    assert.ok(!composed.aborted);
    c1.abort(new Error("first"));
    // Allow the listener microtask to run.
    await new Promise(r => setTimeout(r, 0));
    assert.ok(composed.aborted);
  });

  it("aborting second source aborts composite", async () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    const composed = composeSignals(c1.signal, c2.signal);
    assert.ok(!composed.aborted);
    c2.abort(new Error("second"));
    await new Promise(r => setTimeout(r, 0));
    assert.ok(composed.aborted);
  });

  it("already-aborted source makes composite start aborted", () => {
    const c1 = new AbortController();
    c1.abort(new Error("pre-aborted"));
    const c2 = new AbortController();
    const composed = composeSignals(c1.signal, c2.signal);
    assert.ok(composed.aborted);
  });

  it("composeSignals(undefined, sig) returns the single signal", () => {
    const c = new AbortController();
    const result = composeSignals(undefined, c.signal);
    assert.equal(result, c.signal);
  });

  it("returns undefined when all inputs are falsy", () => {
    const result = composeSignals(undefined, null, false);
    assert.equal(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// (e) isTimeoutError
// ---------------------------------------------------------------------------
describe("isTimeoutError", () => {
  it("true for a DOMException with name=TimeoutError", () => {
    const err = new DOMException("timed out", "TimeoutError");
    assert.ok(isTimeoutError(err));
  });

  it("true when err.cause.name === TimeoutError", () => {
    const cause = new DOMException("inner", "TimeoutError");
    const outer = new Error("wrapper");
    outer.cause = cause;
    assert.ok(isTimeoutError(outer));
  });

  it("false for a generic Error", () => {
    assert.ok(!isTimeoutError(new Error("nope")));
  });

  it("false for null/undefined", () => {
    assert.ok(!isTimeoutError(null));
    assert.ok(!isTimeoutError(undefined));
  });
});
