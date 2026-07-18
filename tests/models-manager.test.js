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
} from "../servers/gateway/models/manager.js";
import { loadState } from "../servers/gateway/models/state.js";

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
    real.write = (chunk, ...rest) => {
      written += chunk.length;
      if (written > thresholdBytes) {
        setImmediate(() => {
          real.emit("error", Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
        });
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
      const common = { dir, catalog, lookup: lookupToLocalhost, baseUrl: `http://huggingface.co:${port}` };

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
