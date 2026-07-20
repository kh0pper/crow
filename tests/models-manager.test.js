/**
 * Tests for servers/gateway/models/manager.js — the GGUF download pipeline
 * (Item G, Task 6).
 *
 * Every test runs against a LOCAL node:http fixture server (listen on
 * 127.0.0.1, OS-assigned or explicitly reused ports) — no real network
 * traffic ever leaves this process. Host-allowlist tests use a real
 * huggingface.co-family hostname in the download URL together with an
 * injected `lookup` (Node's standard http/https request option) that
 * forces DNS resolution straight to 127.0.0.1, so the allowlist check runs
 * against the actual literal hostnames named in the spec while every
 * socket still talks to the local fixture server.
 *
 * The manager also requires https on every hop by default (see
 * `DownloadProtocolError`, code INSECURE_PROTOCOL). Since every fixture
 * server here is plain http, tests pass the test-only `insecureHttpHosts`
 * escape (`INSECURE_HF` / `INSECURE_HF_AND_CDN` below) naming exactly the
 * hostnames they dial — production never sets this option. Two dedicated
 * tests ("plain http ... is rejected" and "an https-to-http downgrade
 * redirect is rejected") prove what happens WITHOUT the escape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  openSync,
  writeSync,
  closeSync,
  createWriteStream as fsCreateWriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  downloadModel,
  deleteModel,
  enqueueDownload,
  getDownloadConcurrency,
  isAllowedHost,
  buildDownloadUrl,
  sanitizeFilename,
  resolveEntry,
  HostNotAllowedError,
  ChecksumError,
  DiskFullError,
  UnsafeDestinationError,
  DownloadProtocolError,
  DownloadTimeoutError,
  HttpStatusError,
  HfMetadataError,
  HfFileNotFoundError,
  NoVerifiableChecksumError,
  isValidHfRepoId,
  isValidHfFilename,
  deriveModelIdFromFilename,
  fetchHfPathInfo,
  downloadHfFile,
  fetchModelBlob,
} from "../servers/gateway/models/manager.js";
import { loadState } from "../servers/gateway/models/state.js";

// Every fixture server in this file is plain http (no TLS) — this is the
// explicit test-only escape from the manager's https-only enforcement.
// Production NEVER sets insecureHttpHosts; see the two dedicated tests
// below ("http to an allowlisted host is rejected" and "downgrade redirect
// is rejected") for what happens WITHOUT it.
const INSECURE_HF = ["huggingface.co"];
const INSECURE_HF_AND_CDN = ["huggingface.co", "cdn-lfs.huggingface.co"];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBlob(size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = i % 256;
  return buf;
}

const BLOB = makeBlob(300_000);
const BLOB_SHA256 = createHash("sha256").update(BLOB).digest("hex");

function scratchDir(tag) {
  return mkdtempSync(join(tmpdir(), `models-manager-${tag}-`));
}

function startServer(handler) {
  return new Promise((resolvePromise, reject) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolvePromise({ srv, port: srv.address().port }));
    srv.on("error", reject);
  });
}

function startServerOnPort(port, handler) {
  return new Promise((resolvePromise, reject) => {
    const srv = http.createServer(handler);
    srv.listen(port, "127.0.0.1", () => resolvePromise({ srv, port }));
    srv.on("error", reject);
  });
}

function getFreePort() {
  return new Promise((resolvePromise, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePromise(port));
    });
    probe.on("error", reject);
  });
}

function stopServer(srv) {
  return new Promise((resolvePromise) => srv.close(() => resolvePromise()));
}

/** Forces every hostname to 127.0.0.1 — lets tests use real huggingface.co
 * / hf.co-family / disallowed hostnames in URLs with zero real DNS or
 * network traffic. Handles both the classic single-address callback shape
 * and the `{ all: true }` shape Node's happy-eyeballs multi-address connect
 * path (net's `lookupAndConnectMultiple`) requests. */
function lookupToLocalhost(_hostname, options, callback) {
  if (options && options.all) {
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
  } else {
    callback(null, "127.0.0.1", 4);
  }
}

function rangeAwareHandler(blob) {
  return (req, res) => {
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-/.exec(range);
      const start = m ? Number.parseInt(m[1], 10) : 0;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${blob.length - 1}/${blob.length}`,
        "Content-Length": String(blob.length - start),
      });
      res.end(blob.subarray(start));
    } else {
      res.writeHead(200, { "Content-Length": String(blob.length) });
      res.end(blob);
    }
  };
}

function killAtHalfHandler(blob) {
  return (req, res) => {
    res.writeHead(200, { "Content-Length": String(blob.length) });
    const half = Math.floor(blob.length / 2);
    res.write(blob.subarray(0, half));
    setTimeout(() => res.destroy(), 15);
  };
}

/** Headers + a partial body, then genuine silence — never destroys the
 * connection, never ends the response. Distinct from `killAtHalfHandler`
 * (which actively severs the connection): this simulates a black-holed/
 * hung peer, exactly what Fix 4's socket-idle timeout exists to detect. */
function stallAfterHalfHandler(blob) {
  return (req, res) => {
    res.writeHead(200, { "Content-Length": String(blob.length) });
    const half = Math.floor(blob.length / 2);
    res.write(blob.subarray(0, half));
    // deliberately never res.end() / res.destroy() — a real stall
  };
}

function makeCatalog({ hfRepo = "test/repo", file = "blob.gguf", sha256 = BLOB_SHA256, quant = "Q4_K_M" } = {}) {
  return {
    version: 1,
    models: [
      {
        id: "test-model",
        hf_repo: hfRepo,
        default_quant: quant,
        quants: [{ file, quant, sha256 }],
      },
    ],
  };
}

function makeEnospcWriteStream(thresholdBytes) {
  return (dest, opts) => {
    const real = fsCreateWriteStream(dest, opts);
    let written = 0;
    const originalWrite = real.write.bind(real);
    const emitEnospc = () => {
      real.emit("error", Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
    };
    real.write = (chunk, ...rest) => {
      written += chunk.length;
      if (written > thresholdBytes) {
        // A real ENOSPC can only ever surface on a write() to an fd that's
        // already open -- the OS has no way to fail a write before open()
        // has completed. `real`'s underlying open() is itself async (fs
        // streams construct via `_construct`, dispatched on a nextTick that
        // races the `res.on("data", ...)` handler feeding this write()
        // override), so under scheduler/I-O contention (parallel test
        // files, a loaded CI runner) the very first write() here can land
        // before that open() has finished. Emitting the injected error
        // immediately in that window models a failure the real OS could
        // never produce, and lets `real.destroy()` (in the product's
        // `streamToFile` fail() path) tear the stream down before it has
        // ever created `dest` on disk -- flaking the "partial file kept"
        // assertion below with no product bug involved. Waiting for the
        // real `"open"` event first keeps the injected failure physically
        // honest and removes the race by construction.
        if (typeof real.fd === "number") {
          setImmediate(emitEnospc);
        } else {
          real.once("open", () => setImmediate(emitEnospc));
        }
        return false;
      }
      return originalWrite(chunk, ...rest);
    };
    return real;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — no network, no filesystem
// ---------------------------------------------------------------------------

test("isAllowedHost allows huggingface.co and its subdomains, case-insensitively", () => {
  assert.equal(isAllowedHost("huggingface.co"), true);
  assert.equal(isAllowedHost("cdn-lfs.huggingface.co"), true);
  assert.equal(isAllowedHost("HuggingFace.CO"), true);
});

test("isAllowedHost allows hf.co subdomains but NOT the bare hf.co apex", () => {
  assert.equal(isAllowedHost("sub.hf.co"), true);
  assert.equal(isAllowedHost("cdn.lfs.hf.co"), true);
  assert.equal(isAllowedHost("hf.co"), false);
});

test("isAllowedHost rejects lookalike and unrelated hosts", () => {
  assert.equal(isAllowedHost("evilhuggingface.co"), false);
  assert.equal(isAllowedHost("evil.example.com"), false);
  assert.equal(isAllowedHost("huggingface.co.evil.com"), false);
  assert.equal(isAllowedHost(""), false);
  assert.equal(isAllowedHost(undefined), false);
});

test("buildDownloadUrl builds the real huggingface.co resolve URL by default", () => {
  assert.equal(
    buildDownloadUrl("Qwen/Qwen3-4B-GGUF", "Qwen3-4B-Q4_K_M.gguf"),
    "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf",
  );
});

test("sanitizeFilename strips directories and rejects . / ..", () => {
  assert.equal(sanitizeFilename("blob.gguf"), "blob.gguf");
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.throws(() => sanitizeFilename(".."), UnsafeDestinationError);
  assert.throws(() => sanitizeFilename("."), UnsafeDestinationError);
});

test("resolveEntry finds the model + default quant, and rejects unknown ids", () => {
  const catalog = makeCatalog();
  const { model, quantEntry } = resolveEntry(catalog, "test-model");
  assert.equal(model.id, "test-model");
  assert.equal(quantEntry.quant, "Q4_K_M");
  assert.throws(() => resolveEntry(catalog, "nope"));
});

test("getDownloadConcurrency clamps CROW_MODEL_DL_CONCURRENCY to [1,2]", () => {
  const prev = process.env.CROW_MODEL_DL_CONCURRENCY;
  try {
    delete process.env.CROW_MODEL_DL_CONCURRENCY;
    assert.equal(getDownloadConcurrency(), 1);
    process.env.CROW_MODEL_DL_CONCURRENCY = "2";
    assert.equal(getDownloadConcurrency(), 2);
    process.env.CROW_MODEL_DL_CONCURRENCY = "5";
    assert.equal(getDownloadConcurrency(), 2);
    process.env.CROW_MODEL_DL_CONCURRENCY = "0";
    assert.equal(getDownloadConcurrency(), 1);
    process.env.CROW_MODEL_DL_CONCURRENCY = "not-a-number";
    assert.equal(getDownloadConcurrency(), 1);
  } finally {
    if (prev === undefined) delete process.env.CROW_MODEL_DL_CONCURRENCY;
    else process.env.CROW_MODEL_DL_CONCURRENCY = prev;
  }
});

// ---------------------------------------------------------------------------
// downloadModel — full happy path
// ---------------------------------------------------------------------------

test("downloadModel streams the full blob to disk and verifies sha256 incrementally", async () => {
  const { srv, port } = await startServer(rangeAwareHandler(BLOB));
  try {
    const dir = scratchDir("full");
    try {
      const catalog = makeCatalog();
      const progressCalls = [];
      const result = await downloadModel({
        modelId: "test-model",
        dir,
        catalog,
        lookup: lookupToLocalhost,
        baseUrl: `http://huggingface.co:${port}`,
        insecureHttpHosts: INSECURE_HF,
        onProgress: (p) => progressCalls.push(p),
      });
      assert.equal(result.sha256, BLOB_SHA256);
      assert.deepEqual(readFileSync(result.path), BLOB);
      assert.ok(progressCalls.length > 0, "expected at least one progress callback");
      assert.equal(progressCalls.at(-1).bytesDone, BLOB.length);

      const state = loadState(dir);
      assert.equal(state.journal["test-model"], undefined, "journal entry should be cleared on success");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopServer(srv);
  }
});

// ---------------------------------------------------------------------------
// Checksum mismatch
// ---------------------------------------------------------------------------

test("wrong sha256 deletes the file and throws a typed ChecksumError", async () => {
  const { srv, port } = await startServer(rangeAwareHandler(BLOB));
  try {
    const dir = scratchDir("badsha");
    try {
      const catalog = makeCatalog({ sha256: "0".repeat(64) });
      await assert.rejects(
        () =>
          downloadModel({
            modelId: "test-model",
            dir,
            catalog,
            lookup: lookupToLocalhost,
            baseUrl: `http://huggingface.co:${port}`,
            insecureHttpHosts: INSECURE_HF,
          }),
        (err) => {
          assert.ok(err instanceof ChecksumError, `expected ChecksumError, got ${err}`);
          assert.equal(err.expectedSha, "0".repeat(64));
          return true;
        },
      );
      const dest = join(dir, "models", "blobs", "blob.gguf");
      assert.equal(existsSync(dest), false, "bad blob must be deleted");

      const state = loadState(dir);
      assert.equal(state.journal["test-model"], undefined, "no journal entry left for a checksum-mismatched blob");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopServer(srv);
  }
});

// ---------------------------------------------------------------------------
// Interrupted download journals progress
// ---------------------------------------------------------------------------

test("interrupted download (socket killed mid-stream) journals bytesDone", async () => {
  const { srv, port } = await startServer(killAtHalfHandler(BLOB));
  try {
    const dir = scratchDir("interrupt");
    try {
      const catalog = makeCatalog();
      await assert.rejects(() =>
        downloadModel({
          modelId: "test-model",
          dir,
          catalog,
          lookup: lookupToLocalhost,
          baseUrl: `http://huggingface.co:${port}`,
          insecureHttpHosts: INSECURE_HF,
        }),
      );
      const state = loadState(dir);
      const entry = state.journal["test-model"];
      assert.ok(entry, "expected a journal entry after interruption");
      assert.ok(
        entry.bytesDone > 0 && entry.bytesDone < BLOB.length,
        `expected partial bytesDone, got ${entry.bytesDone}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopServer(srv);
  }
});

// ---------------------------------------------------------------------------
// Final-review fix wave — Fix 4: GGUF downloads had no socket timeout
// ---------------------------------------------------------------------------

test("Fix 4: a connection that never sends headers rejects with a typed DownloadTimeoutError instead of hanging forever", async () => {
  // Accepts the connection but never writes a byte and never ends the
  // response — the connect/header-wait phase, handled by requestOnce's own
  // Node socket-timeout option (mirrors runtime.js's identical test for
  // downloadRuntimeAsset).
  const { srv, port } = await startServer(() => {});
  const dir = scratchDir("dl-connect-stall");
  try {
    const dest = join(dir, "connect-stall.gguf");
    await assert.rejects(
      () => fetchModelBlob({
        url: `http://huggingface.co:${port}/x/resolve/main/y.gguf`,
        dest,
        lookup: lookupToLocalhost,
        insecureHttpHosts: INSECURE_HF,
        timeoutMs: 50, // tiny for a fast test — production default is 120s
      }),
      (err) => {
        assert.ok(err instanceof DownloadTimeoutError, `expected DownloadTimeoutError, got ${err}`);
        assert.equal(err.code, "DOWNLOAD_TIMEOUT");
        assert.equal(err.timeoutMs, 50);
        return true;
      },
    );
    assert.equal(existsSync(dest), false, "no partial file — the stall was never past the connect/header phase");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stopServer(srv);
  }
});

test("Fix 4: a connection that sends headers + partial body then stalls rejects with a typed DownloadTimeoutError within the injected timeout; partial file is kept, not deleted", async () => {
  const { srv, port } = await startServer(stallAfterHalfHandler(BLOB));
  try {
    const dir = scratchDir("dl-body-stall");
    try {
      const dest = join(dir, "body-stall.gguf");
      await assert.rejects(
        () => fetchModelBlob({
          url: `http://huggingface.co:${port}/x/resolve/main/y.gguf`,
          dest,
          lookup: lookupToLocalhost,
          insecureHttpHosts: INSECURE_HF,
          timeoutMs: 50,
        }),
        (err) => {
          assert.ok(err instanceof DownloadTimeoutError, `expected DownloadTimeoutError, got ${err}`);
          assert.equal(err.code, "DOWNLOAD_TIMEOUT");
          assert.ok(err.bytesDone > 0 && err.bytesDone < BLOB.length, `expected partial bytesDone on the error, got ${err.bytesDone}`);
          return true;
        },
      );
      assert.equal(existsSync(dest), true, "the partial file is KEPT on disk (like DiskFullError), not deleted (unlike ChecksumError)");
      const onDisk = readFileSync(dest);
      assert.ok(onDisk.length > 0 && onDisk.length < BLOB.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopServer(srv);
  }
});

test("Fix 4: downloadModel journals bytesDone on a body stall, so a subsequent call resumes rather than restarting", async () => {
  const { srv, port } = await startServer(stallAfterHalfHandler(BLOB));
  try {
    const dir = scratchDir("dl-model-stall");
    try {
      const catalog = makeCatalog();
      await assert.rejects(
        () => downloadModel({
          modelId: "test-model",
          dir,
          catalog,
          lookup: lookupToLocalhost,
          baseUrl: `http://huggingface.co:${port}`,
          insecureHttpHosts: INSECURE_HF,
          timeoutMs: 50,
        }),
        (err) => {
          assert.ok(err instanceof DownloadTimeoutError, `expected DownloadTimeoutError, got ${err}`);
          return true;
        },
      );
      const state = loadState(dir);
      const entry = state.journal["test-model"];
      assert.ok(entry, "expected a journal entry after the stall");
      assert.ok(entry.bytesDone > 0 && entry.bytesDone < BLOB.length, `expected partial bytesDone, got ${entry.bytesDone}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopServer(srv);
  }
});

test("Fix 4: fetchModelBlob without an explicit timeoutMs defaults to DEFAULT_DOWNLOAD_TIMEOUT_MS and does not spuriously time out a normal fast download", async () => {
  const { srv, port } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Length": String(BLOB.length) });
    res.end(BLOB);
  });
  const dir = scratchDir("dl-default-timeout");
  try {
    const dest = join(dir, "fast.gguf");
    const result = await fetchModelBlob({
      url: `http://huggingface.co:${port}/x/resolve/main/y.gguf`,
      dest,
      lookup: lookupToLocalhost,
      insecureHttpHosts: INSECURE_HF,
      // timeoutMs omitted — the default (120s) must not fire for a fast,
      // successful download.
    });
    assert.equal(result.sha256, BLOB_SHA256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stopServer(srv);
  }
});

// ---------------------------------------------------------------------------
// Resume: Range from journal, re-hash on-disk prefix, final sha matches
// ---------------------------------------------------------------------------

test("resume issues Range from journal bytesDone, re-hashes the prefix, and completes with a matching sha256", async () => {
  const port = await getFreePort();
  const dir = scratchDir("resume");
  try {
    const catalog = makeCatalog();

    // Phase 1: interrupted at ~50%.
    const phase1 = await startServerOnPort(port, killAtHalfHandler(BLOB));
    await assert.rejects(() =>
      downloadModel({
        modelId: "test-model",
        dir,
        catalog,
        lookup: lookupToLocalhost,
        baseUrl: `http://huggingface.co:${port}`,
        insecureHttpHosts: INSECURE_HF,
      }),
    );
    await stopServer(phase1.srv);

    const journaled = loadState(dir).journal["test-model"];
    assert.ok(journaled, "expected a journal entry after phase 1");
    const bytesAfterInterrupt = journaled.bytesDone;
    assert.ok(bytesAfterInterrupt > 0 && bytesAfterInterrupt < BLOB.length);

    // Phase 2: same URL (same port) resumes; assert the Range header sent
    // matches the journaled offset exactly.
    let seenRange;
    const phase2 = await startServerOnPort(port, (req, res) => {
      seenRange = req.headers.range || null;
      rangeAwareHandler(BLOB)(req, res);
    });
    try {
      const result = await downloadModel({
        modelId: "test-model",
        dir,
        catalog,
        lookup: lookupToLocalhost,
        baseUrl: `http://huggingface.co:${port}`,
        insecureHttpHosts: INSECURE_HF,
      });
      assert.equal(seenRange, `bytes=${bytesAfterInterrupt}-`);
      assert.equal(result.sha256, BLOB_SHA256);
      assert.deepEqual(readFileSync(result.path), BLOB);

      const state = loadState(dir);
      assert.equal(state.journal["test-model"], undefined);
    } finally {
      await stopServer(phase2.srv);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resuming over a corrupted on-disk prefix produces a ChecksumError", async () => {
  const port = await getFreePort();
  const dir = scratchDir("corrupt-resume");
  try {
    const catalog = makeCatalog();

    // Phase 1: interrupted partway through, same as the resume test above.
    const phase1 = await startServerOnPort(port, killAtHalfHandler(BLOB));
    await assert.rejects(() =>
      downloadModel({
        modelId: "test-model",
        dir,
        catalog,
        lookup: lookupToLocalhost,
        baseUrl: `http://huggingface.co:${port}`,
        insecureHttpHosts: INSECURE_HF,
      }),
    );
    await stopServer(phase1.srv);

    const journaled = loadState(dir).journal["test-model"];
    assert.ok(journaled, "expected a journal entry after phase 1");
    assert.ok(journaled.bytesDone > 0 && journaled.bytesDone < BLOB.length);

    // Corrupt a byte inside the already-written prefix, BEFORE resuming —
    // the resume path re-hashes exactly this on-disk range from scratch, so
    // a flipped byte here must surface as a final checksum mismatch even
    // though the rest of the download completes normally.
    const dest = join(dir, "models", "blobs", "blob.gguf");
    const flipOffset = Math.floor(journaled.bytesDone / 2);
    const fd = openSync(dest, "r+");
    try {
      writeSync(fd, Buffer.from([BLOB[flipOffset] ^ 0xff]), 0, 1, flipOffset);
    } finally {
      closeSync(fd);
    }

    const phase2 = await startServerOnPort(port, rangeAwareHandler(BLOB));
    try {
      await assert.rejects(
        () =>
          downloadModel({
            modelId: "test-model",
            dir,
            catalog,
            lookup: lookupToLocalhost,
            baseUrl: `http://huggingface.co:${port}`,
            insecureHttpHosts: INSECURE_HF,
          }),
        (err) => {
          assert.ok(err instanceof ChecksumError, `expected ChecksumError, got ${err}`);
          return true;
        },
      );
      // The corrupted (now known-bad) blob must be deleted, same as any
      // other checksum mismatch.
      assert.equal(existsSync(dest), false);
    } finally {
      await stopServer(phase2.srv);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ENOSPC -> DiskFullError, partial kept
// ---------------------------------------------------------------------------

test("write-stream ENOSPC error becomes a typed DiskFullError and keeps the partial file", async () => {
  const { srv, port } = await startServer(rangeAwareHandler(BLOB));
  try {
    const dir = scratchDir("enospc");
    try {
      const catalog = makeCatalog();
      await assert.rejects(
        () =>
          downloadModel({
            modelId: "test-model",
            dir,
            catalog,
            lookup: lookupToLocalhost,
            baseUrl: `http://huggingface.co:${port}`,
            insecureHttpHosts: INSECURE_HF,
            createWriteStream: makeEnospcWriteStream(50_000),
          }),
        (err) => {
          assert.ok(err instanceof DiskFullError, `expected DiskFullError, got ${err}`);
          return true;
        },
      );
      const dest = join(dir, "models", "blobs", "blob.gguf");
      assert.ok(existsSync(dest), "partial file must be kept for resume");

      const state = loadState(dir);
      assert.ok(state.journal["test-model"], "journal entry must remain so a later call can resume");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopServer(srv);
  }
});

// ---------------------------------------------------------------------------
// Host allowlist
// ---------------------------------------------------------------------------

test("redirect to a disallowed host is refused with a typed HostNotAllowedError", async () => {
  const port = await getFreePort();
  const { srv } = await startServerOnPort(
    port,
    (req, res) => {
      res.writeHead(302, { Location: `http://evil.example.com:${port}/x` });
      res.end();
    },
  );
  try {
    const dir = scratchDir("evilhost");
    try {
      const catalog = makeCatalog();
      await assert.rejects(
        () =>
          downloadModel({
            modelId: "test-model",
            dir,
            catalog,
            lookup: lookupToLocalhost,
            baseUrl: `http://huggingface.co:${port}`,
            insecureHttpHosts: INSECURE_HF,
          }),
        (err) => {
          assert.ok(err instanceof HostNotAllowedError, `expected HostNotAllowedError, got ${err}`);
          assert.equal(err.hostname, "evil.example.com");
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopServer(srv);
  }
});

test("redirect to an allowed hf.co-family host is followed to a successful completion", async () => {
  const port = await getFreePort();
  const location = `http://cdn-lfs.huggingface.co:${port}/cdn-path/blob.gguf`;
  const { srv } = await startServerOnPort(port, (req, res) => {
    if (req.url.includes("/resolve/main/")) {
      res.writeHead(302, { Location: location });
      res.end();
      return;
    }
    rangeAwareHandler(BLOB)(req, res);
  });
  try {
    const dir = scratchDir("redirectok");
    try {
      const catalog = makeCatalog();
      const result = await downloadModel({
        modelId: "test-model",
        dir,
        catalog,
        lookup: lookupToLocalhost,
        baseUrl: `http://huggingface.co:${port}`,
        insecureHttpHosts: INSECURE_HF_AND_CDN,
      });
      assert.equal(result.sha256, BLOB_SHA256);
      assert.deepEqual(readFileSync(result.path), BLOB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopServer(srv);
  }
});

// ---------------------------------------------------------------------------
// HTTPS enforcement
// ---------------------------------------------------------------------------

test("plain http to an allowlisted host is rejected without the insecureHttpHosts escape", async () => {
  const { srv, port } = await startServer(rangeAwareHandler(BLOB));
  try {
    const dir = scratchDir("http-rejected");
    try {
      const catalog = makeCatalog();
      let requestsReceived = 0;
      srv.on("request", () => { requestsReceived++; });
      await assert.rejects(
        () =>
          downloadModel({
            modelId: "test-model",
            dir,
            catalog,
            lookup: lookupToLocalhost,
            baseUrl: `http://huggingface.co:${port}`,
            // no insecureHttpHosts — https is required by default
          }),
        (err) => {
          assert.ok(err instanceof DownloadProtocolError, `expected DownloadProtocolError, got ${err}`);
          assert.equal(err.code, "INSECURE_PROTOCOL");
          return true;
        },
      );
      assert.equal(requestsReceived, 0, "must be refused before ever connecting");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopServer(srv);
  }
});

test("an https-to-http downgrade redirect is rejected even to an otherwise-allowed host", async () => {
  // Models the real hazard: buildDownloadUrl's production output is always
  // https, but a compromised/misconfigured redirect could point somewhere
  // that downgrades to http. The initial hop is explicitly escaped
  // (INSECURE_HF, standing in for "we already validated this connection");
  // the redirect target is a DIFFERENT allowed-by-hostname host that is
  // deliberately NOT in the escape list, proving each hop's protocol is
  // checked independently rather than only the first URL.
  const port = await getFreePort();
  const downgradeLocation = `http://cdn-lfs.huggingface.co:${port}/downgraded/blob.gguf`;
  const { srv } = await startServerOnPort(port, (req, res) => {
    if (req.url.includes("/resolve/main/")) {
      res.writeHead(302, { Location: downgradeLocation });
      res.end();
      return;
    }
    // Should never be reached — the downgrade must be refused before this.
    rangeAwareHandler(BLOB)(req, res);
  });
  try {
    const dir = scratchDir("downgrade");
    try {
      const catalog = makeCatalog();
      await assert.rejects(
        () =>
          downloadModel({
            modelId: "test-model",
            dir,
            catalog,
            lookup: lookupToLocalhost,
            baseUrl: `http://huggingface.co:${port}`,
            insecureHttpHosts: INSECURE_HF, // cdn-lfs.huggingface.co is deliberately NOT escaped
          }),
        (err) => {
          assert.ok(err instanceof DownloadProtocolError, `expected DownloadProtocolError, got ${err}`);
          assert.equal(err.code, "INSECURE_PROTOCOL");
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopServer(srv);
  }
});

// ---------------------------------------------------------------------------
// Symlink-at-destination refusal
// ---------------------------------------------------------------------------

test("an existing symlink at the destination path is refused before any network activity", async () => {
  const dir = scratchDir("symlink");
  try {
    const blobDir = join(dir, "models", "blobs");
    mkdirSync(blobDir, { recursive: true });
    const dest = join(blobDir, "blob.gguf");
    const target = join(dir, "elsewhere.txt");
    writeFileSync(target, "not a model file");
    symlinkSync(target, dest);

    const catalog = makeCatalog();
    await assert.rejects(
      () => downloadModel({ modelId: "test-model", dir, catalog }),
      (err) => {
        assert.ok(err instanceof UnsafeDestinationError, `expected UnsafeDestinationError, got ${err}`);
        return true;
      },
    );
    // The symlink target must be untouched.
    assert.equal(readFileSync(target, "utf8"), "not a model file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// deleteModel
// ---------------------------------------------------------------------------

test("deleteModel removes the downloaded blob and any journal entry", async () => {
  const { srv, port } = await startServer(rangeAwareHandler(BLOB));
  try {
    const dir = scratchDir("delete");
    try {
      const catalog = makeCatalog();
      const result = await downloadModel({
        modelId: "test-model",
        dir,
        catalog,
        lookup: lookupToLocalhost,
        baseUrl: `http://huggingface.co:${port}`,
        insecureHttpHosts: INSECURE_HF,
      });
      assert.ok(existsSync(result.path));

      const del = deleteModel({ modelId: "test-model", dir, catalog });
      assert.equal(del.deleted, true);
      assert.equal(existsSync(result.path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopServer(srv);
  }
});

test("deleteModel is a no-op (deleted:false) when nothing is on disk", () => {
  const dir = scratchDir("delete-noop");
  try {
    const catalog = makeCatalog();
    const del = deleteModel({ modelId: "test-model", dir, catalog });
    assert.equal(del.deleted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Queue: concurrency-1 serialization
// ---------------------------------------------------------------------------

test("enqueueDownload runs two downloads serially under the default concurrency of 1", async () => {
  const prevConcurrency = process.env.CROW_MODEL_DL_CONCURRENCY;
  delete process.env.CROW_MODEL_DL_CONCURRENCY;
  const port = await getFreePort();
  const timestamps = {};
  const { srv } = await startServerOnPort(port, (req, res) => {
    const key = req.url.includes("blob-a") ? "a" : "b";
    timestamps[`${key}Start`] = Date.now();
    setTimeout(() => {
      res.writeHead(200, { "Content-Length": String(BLOB.length) });
      res.end(BLOB);
      timestamps[`${key}End`] = Date.now();
    }, 60);
  });
  try {
    const dir = scratchDir("queue");
    try {
      const catalog = {
        version: 1,
        models: [
          {
            id: "model-a",
            hf_repo: "test/repo",
            default_quant: "Q4_K_M",
            quants: [{ file: "blob-a.gguf", quant: "Q4_K_M", sha256: BLOB_SHA256 }],
          },
          {
            id: "model-b",
            hf_repo: "test/repo",
            default_quant: "Q4_K_M",
            quants: [{ file: "blob-b.gguf", quant: "Q4_K_M", sha256: BLOB_SHA256 }],
          },
        ],
      };
      const common = {
        dir,
        catalog,
        lookup: lookupToLocalhost,
        baseUrl: `http://huggingface.co:${port}`,
        insecureHttpHosts: INSECURE_HF,
      };

      const [ra, rb] = await Promise.all([
        enqueueDownload({ modelId: "model-a", ...common }),
        enqueueDownload({ modelId: "model-b", ...common }),
      ]);
      assert.equal(ra.sha256, BLOB_SHA256);
      assert.equal(rb.sha256, BLOB_SHA256);

      assert.ok(timestamps.aStart && timestamps.aEnd && timestamps.bStart && timestamps.bEnd);
      const firstEnd = Math.min(timestamps.aEnd, timestamps.bEnd);
      const secondStart = timestamps.aEnd < timestamps.bEnd ? timestamps.bStart : timestamps.aStart;
      assert.ok(
        secondStart >= firstEnd,
        `expected serial (non-overlapping) execution, got firstEnd=${firstEnd} secondStart=${secondStart}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopServer(srv);
    if (prevConcurrency === undefined) delete process.env.CROW_MODEL_DL_CONCURRENCY;
    else process.env.CROW_MODEL_DL_CONCURRENCY = prevConcurrency;
  }
});

test("enqueueDownload is idempotent per modelId: a second enqueue while one is in flight returns the same job", async () => {
  let requestCount = 0;
  const { srv, port } = await startServer((req, res) => {
    requestCount++;
    // Small delay so both enqueue calls land while the first request is
    // still in flight, giving the dedup a real window to matter.
    setTimeout(() => rangeAwareHandler(BLOB)(req, res), 30);
  });
  try {
    const dir = scratchDir("dedup");
    try {
      const catalog = makeCatalog();
      const opts = {
        modelId: "test-model",
        dir,
        catalog,
        lookup: lookupToLocalhost,
        baseUrl: `http://huggingface.co:${port}`,
        insecureHttpHosts: INSECURE_HF,
      };

      const p1 = enqueueDownload(opts);
      const p2 = enqueueDownload(opts);
      assert.equal(p1, p2, "a second enqueue while the first is in flight must return the SAME promise");

      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal(r1.sha256, BLOB_SHA256);
      assert.equal(r2.sha256, BLOB_SHA256);
      assert.equal(requestCount, 1, "the underlying download must only run once — no second writer on the same dest");

      // Once settled, the dedup entry is cleared: a later enqueue for the
      // same modelId is a genuinely fresh job, not the stale cached one.
      const p3 = enqueueDownload(opts);
      assert.notEqual(p3, p1);
      const r3 = await p3;
      assert.equal(r3.sha256, BLOB_SHA256);
      assert.equal(requestCount, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopServer(srv);
  }
});

// ---------------------------------------------------------------------------
// Task 13 fix round 1, finding d: typed HTTP status error
// ---------------------------------------------------------------------------

test("a non-redirect, non-200/206 HTTP status throws a typed HttpStatusError with statusCode + code", async () => {
  const { srv, port } = await startServer((req, res) => {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Forbidden");
  });
  try {
    const dir = scratchDir("http-status");
    try {
      await assert.rejects(
        () => downloadModel({
          modelId: "test-model", dir, catalog: makeCatalog(),
          lookup: lookupToLocalhost, baseUrl: `http://huggingface.co:${port}`, insecureHttpHosts: INSECURE_HF,
        }),
        (err) => {
          assert.ok(err instanceof HttpStatusError, `expected HttpStatusError, got ${err.constructor.name}`);
          assert.equal(err.statusCode, 403);
          assert.equal(err.code, "HTTP_403");
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopServer(srv);
  }
});

test("HttpStatusError.code varies with the actual status (404 -> HTTP_404)", async () => {
  const { srv, port } = await startServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  try {
    await assert.rejects(
      () => fetchModelBlob({
        url: `http://huggingface.co:${port}/repo/resolve/main/f.gguf`,
        dest: join(scratchDir("http-404"), "f.gguf"),
        lookup: lookupToLocalhost,
        insecureHttpHosts: INSECURE_HF,
      }),
      (err) => {
        assert.equal(err.code, "HTTP_404");
        assert.equal(err.statusCode, 404);
        return true;
      },
    );
  } finally {
    await stopServer(srv);
  }
});

// ---------------------------------------------------------------------------
// Task 13 fix round 1, finding 1: Browse Hugging Face downloads
// ---------------------------------------------------------------------------

/** Shape validators — pure, no I/O. */
test("isValidHfRepoId: exactly owner/name, conservative charset, no traversal", () => {
  assert.equal(isValidHfRepoId("Qwen/Qwen3-4B-GGUF"), true);
  assert.equal(isValidHfRepoId("org-name/repo.name_2"), true);
  assert.equal(isValidHfRepoId("noSlash"), false);
  assert.equal(isValidHfRepoId("a/b/c"), false, "extra path segment rejected");
  assert.equal(isValidHfRepoId("../etc/passwd"), false);
  assert.equal(isValidHfRepoId("/leading-slash"), false);
  assert.equal(isValidHfRepoId("trailing-slash/"), false);
  assert.equal(isValidHfRepoId(""), false);
  assert.equal(isValidHfRepoId(null), false);
  assert.equal(isValidHfRepoId(123), false);
});

test("isValidHfFilename: single sanitized filename, no separators, no traversal", () => {
  assert.equal(isValidHfFilename("model-Q4_K_M.gguf"), true);
  assert.equal(isValidHfFilename("a.b_c-9.gguf"), true);
  assert.equal(isValidHfFilename("dir/model.gguf"), false);
  assert.equal(isValidHfFilename("..\\model.gguf"), false);
  assert.equal(isValidHfFilename(".."), false);
  assert.equal(isValidHfFilename("."), false);
  assert.equal(isValidHfFilename(""), false);
  assert.equal(isValidHfFilename(null), false);
});

test("deriveModelIdFromFilename: strips .gguf, lowercases, collapses unsafe chars, trims", () => {
  assert.equal(deriveModelIdFromFilename("Foo-Bar_Q4_K_M.gguf"), "foo-bar_q4_k_m");
  assert.equal(deriveModelIdFromFilename("Weird!!Name??.GGUF"), "weird-name");
  assert.throws(() => deriveModelIdFromFilename("....gguf"), UnsafeDestinationError);
  assert.throws(() => deriveModelIdFromFilename(""), UnsafeDestinationError);
});

/** Local stand-in for Hugging Face's `paths-info` API — routes on method +
 * URL, independent per-call configurable via `mode`. `fetchHfPathInfo` uses
 * plain `fetch()` (no DNS-override tricks needed), so this fixture is
 * addressed directly as `hfApiBase` at its real 127.0.0.1 port. */
function startHfMetaFixture(sha256, size) {
  let mode = "ok"; // ok | no-lfs | not-found | error-500
  let lastHeaders = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      lastHeaders = req.headers;
      if (mode === "error-500") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
        return;
      }
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* ignore */ }
      const paths = Array.isArray(body.paths) ? body.paths : [];
      if (mode === "not-found") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]"); // confirmed live behavior: HF answers 200 [] for a path that doesn't exist
        return;
      }
      const results = paths.map((p) => {
        const entry = { path: p, size, oid: "deadbeef0000gitblobsha1notasha256", type: "file" };
        if (mode !== "no-lfs") entry.lfs = { oid: sha256, size };
        return entry;
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(results));
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.listen(0, "127.0.0.1", () => resolvePromise({
      base: `http://127.0.0.1:${server.address().port}`,
      setMode: (m) => { mode = m; },
      lastHeaders: () => lastHeaders,
      close: () => new Promise((r) => server.close(r)),
    }));
    server.on("error", reject);
  });
}

test("fetchHfPathInfo: LFS file -> real sha256 + size", async () => {
  const fx = await startHfMetaFixture(BLOB_SHA256, BLOB.length);
  try {
    const info = await fetchHfPathInfo({ hfRepo: "org/repo", file: "model.gguf", hfApiBase: fx.base });
    assert.equal(info.sha256, BLOB_SHA256);
    assert.equal(info.sizeBytes, BLOB.length);
  } finally {
    await fx.close();
  }
});

test("fetchHfPathInfo: non-LFS file -> sha256 null (never a git blob hash mistaken for content sha256)", async () => {
  const fx = await startHfMetaFixture(BLOB_SHA256, BLOB.length);
  fx.setMode("no-lfs");
  try {
    const info = await fetchHfPathInfo({ hfRepo: "org/repo", file: "README.md", hfApiBase: fx.base });
    assert.equal(info.sha256, null);
  } finally {
    await fx.close();
  }
});

test("fetchHfPathInfo: nonexistent path in a valid repo (200 []) throws HfFileNotFoundError, not a silent empty result", async () => {
  const fx = await startHfMetaFixture(BLOB_SHA256, BLOB.length);
  fx.setMode("not-found");
  try {
    await assert.rejects(
      () => fetchHfPathInfo({ hfRepo: "org/repo", file: "nope.gguf", hfApiBase: fx.base }),
      HfFileNotFoundError,
    );
  } finally {
    await fx.close();
  }
});

test("fetchHfPathInfo: upstream 500 throws HfMetadataError with statusCode", async () => {
  const fx = await startHfMetaFixture(BLOB_SHA256, BLOB.length);
  fx.setMode("error-500");
  try {
    await assert.rejects(
      () => fetchHfPathInfo({ hfRepo: "org/repo", file: "model.gguf", hfApiBase: fx.base }),
      (err) => {
        assert.ok(err instanceof HfMetadataError);
        assert.equal(err.statusCode, 500);
        return true;
      },
    );
  } finally {
    await fx.close();
  }
});

test("fetchHfPathInfo: forwards the hfToken as a Bearer Authorization header", async () => {
  const fx = await startHfMetaFixture(BLOB_SHA256, BLOB.length);
  try {
    await fetchHfPathInfo({ hfRepo: "org/repo", file: "model.gguf", hfApiBase: fx.base, hfToken: "hf_secrettoken123" });
    assert.equal(fx.lastHeaders().authorization, "Bearer hf_secrettoken123");
  } finally {
    await fx.close();
  }
});

/** Combined fixture serving BOTH the paths-info API (POST, addressed via
 * plain 127.0.0.1 as `hfApiBase`) AND the actual resolve/download endpoint
 * (GET, addressed via the real "huggingface.co" hostname + `lookup`
 * override + `insecureHttpHosts`, exactly like every other download-engine
 * test in this file) — `downloadHfFile` talks to both. */
function startHfCombinedFixture(blob, sha256) {
  let downloadHeaders = null;
  let servedBlob = blob;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && /\/paths-info\//.test(req.url)) {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* ignore */ }
        const paths = Array.isArray(body.paths) ? body.paths : [];
        const results = paths.map((p) => ({ path: p, size: blob.length, oid: "gitblobsha1", lfs: { oid: sha256, size: blob.length } }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(results));
        return;
      }
      // GET /{repo}/resolve/main/{file}
      downloadHeaders = req.headers;
      res.writeHead(200, { "Content-Length": String(servedBlob.length) });
      res.end(servedBlob);
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.listen(0, "127.0.0.1", () => resolvePromise({
      port: server.address().port,
      setServedBlob: (b) => { servedBlob = b; },
      downloadHeaders: () => downloadHeaders,
      close: () => new Promise((r) => server.close(r)),
    }));
    server.on("error", reject);
  });
}

test("downloadHfFile: verifies the fetched sha256, streams to disk, registers via the SAME synthetic catalog it returns", async () => {
  const fx = await startHfCombinedFixture(BLOB, BLOB_SHA256);
  try {
    const dir = scratchDir("hf-download-ok");
    try {
      const result = await downloadHfFile({
        hfRepo: "org/repo",
        file: "org-model-Q4_K_M.gguf",
        dir,
        hfApiBase: `http://127.0.0.1:${fx.port}`,
        lookup: lookupToLocalhost,
        baseUrl: `http://huggingface.co:${fx.port}`,
        insecureHttpHosts: INSECURE_HF,
      });
      assert.equal(result.sha256, BLOB_SHA256);
      assert.equal(result.modelId, "org-model-q4_k_m");
      assert.ok(result.sizeMb > 0);
      assert.equal(result.catalog.models[0].id, "org-model-q4_k_m");
      assert.equal(result.catalog.models[0].quants[0].sha256, BLOB_SHA256);
      assert.ok(existsSync(result.path));
      assert.equal(readFileSync(result.path).length, BLOB.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await fx.close();
  }
});

test("downloadHfFile: a file with no LFS oid is refused BEFORE any download traffic (NoVerifiableChecksumError)", async () => {
  const fx = await startHfMetaFixture(BLOB_SHA256, BLOB.length);
  fx.setMode("no-lfs");
  try {
    const dir = scratchDir("hf-download-nolfs");
    try {
      await assert.rejects(
        () => downloadHfFile({
          hfRepo: "org/repo", file: "README.md", dir,
          hfApiBase: fx.base,
        }),
        NoVerifiableChecksumError,
      );
      // Never touched the blobs dir at all — refused before any download attempt.
      assert.equal(existsSync(join(dir, "models", "blobs")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await fx.close();
  }
});

test("downloadHfFile: a mismatched sha256 (blob doesn't match what paths-info reported) throws ChecksumError and deletes the bad file", async () => {
  const wrongBlob = makeBlob(400_000); // different content -> different real sha256 than BLOB_SHA256
  const fx = await startHfCombinedFixture(wrongBlob, BLOB_SHA256); // paths-info LIES: claims BLOB_SHA256 but serves wrongBlob
  try {
    const dir = scratchDir("hf-download-mismatch");
    try {
      await assert.rejects(
        () => downloadHfFile({
          hfRepo: "org/repo",
          file: "org-model-Q4_K_M.gguf",
          dir,
          hfApiBase: `http://127.0.0.1:${fx.port}`,
          lookup: lookupToLocalhost,
          baseUrl: `http://huggingface.co:${fx.port}`,
          insecureHttpHosts: INSECURE_HF,
        }),
        ChecksumError,
      );
      const dest = join(dir, "models", "blobs", "org-model-Q4_K_M.gguf");
      assert.equal(existsSync(dest), false, "the mismatched file is deleted, never left on disk to be mistaken for good");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await fx.close();
  }
});

test("downloadHfFile: forwards hfToken as a Bearer Authorization header to the ACTUAL download request too (needed for gated repos)", async () => {
  const fx = await startHfCombinedFixture(BLOB, BLOB_SHA256);
  try {
    const dir = scratchDir("hf-download-token");
    try {
      await downloadHfFile({
        hfRepo: "org/repo",
        file: "org-model-Q4_K_M.gguf",
        dir,
        hfToken: "hf_secrettoken456",
        hfApiBase: `http://127.0.0.1:${fx.port}`,
        lookup: lookupToLocalhost,
        baseUrl: `http://huggingface.co:${fx.port}`,
        insecureHttpHosts: INSECURE_HF,
      });
      assert.equal(fx.downloadHeaders().authorization, "Bearer hf_secrettoken456");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await fx.close();
  }
});

test("downloadHfFile: rejects an invalid repo id / filename shape before any network call", async () => {
  await assert.rejects(
    () => downloadHfFile({ hfRepo: "../etc/passwd", file: "x.gguf", dir: scratchDir("hf-bad-repo") }),
    UnsafeDestinationError,
  );
  await assert.rejects(
    () => downloadHfFile({ hfRepo: "org/repo", file: "../../x.gguf", dir: scratchDir("hf-bad-file") }),
    UnsafeDestinationError,
  );
});
