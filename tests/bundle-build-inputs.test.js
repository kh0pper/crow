/**
 * bundle-build-inputs.js — the hash a bundle's image is stamped with (compose build label
 * crow.build-inputs), so Extensions can tell when the image is older than what the
 * installed copy would build.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  buildInputsHash, composeBuildSpecs, dockerfileSources, tracksBuildInputs, containerBuildLabel, BUILD_INPUTS_LABEL,
} from "../servers/gateway/bundle-build-inputs.js";

function put(root, rel, content) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

const COMPOSE = `services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
      labels:
        crow.build-inputs: "\${CROW_BUILD_INPUTS:-}"
    image: x
`;

function bundle() {
  const d = mkdtempSync(join(tmpdir(), "bbi-"));
  put(d, "docker-compose.yml", COMPOSE);
  put(d, "Dockerfile", "FROM python:3.10-slim\nCOPY scripts/a.py /app/a.py\nCOPY --chmod=755 scripts/b.sh \\\n  /app/b.sh\nCOPY --from=builder /x /y\nADD https://example.com/f.tgz /tmp/\n");
  put(d, "scripts/a.py", "print(1)\n");
  put(d, "scripts/b.sh", "echo hi\n");
  put(d, "scripts/unused.js", "1");
  put(d, ".env", "SECRET=1\n");
  return d;
}

test("composeBuildSpecs reads string and mapping build forms", () => {
  assert.deepEqual(composeBuildSpecs(COMPOSE), [{ context: ".", dockerfile: "Dockerfile" }]);
  assert.deepEqual(composeBuildSpecs("services:\n  a:\n    build: ./runner\n"), [{ context: "./runner", dockerfile: "Dockerfile" }]);
  assert.deepEqual(composeBuildSpecs("services:\n  a:\n    image: nginx\n"), []);
});

test("dockerfileSources: COPY/ADD sources, continuations, flags, JSON form; skips --from and URLs", () => {
  const src = dockerfileSources("FROM x\n# COPY nope /n\nCOPY a b /dst/\nCOPY --chown=1:1 [\"c d\", \"/e\"]\ncopy f \\\n /g\nCOPY --from=b /x /y\nADD http://h/z /z\nADD local.tar /l\n");
  assert.deepEqual(src, ["a", "b", "c d", "f", "local.tar"]);
});

test("hash is stable, covers COPY'd files and the Dockerfile, ignores other files and .env", () => {
  const d = bundle();
  const h1 = buildInputsHash(d);
  assert.match(h1, /^[0-9a-f]{20}$/);
  assert.equal(buildInputsHash(d), h1);
  put(d, "scripts/unused.js", "2");
  put(d, ".env", "SECRET=2\n");
  assert.equal(buildInputsHash(d), h1, "a file no COPY names, or .env, never changes the hash");
  put(d, "scripts/a.py", "print(2)\n");
  const h2 = buildInputsHash(d);
  assert.notEqual(h2, h1);
  put(d, "Dockerfile", "FROM python:3.11-slim\nCOPY scripts/a.py /app/a.py\nCOPY --chmod=755 scripts/b.sh /app/b.sh\n");
  assert.notEqual(buildInputsHash(d), h2);
});

test("a directory source hashes its files; a glob falls back to the whole context minus .env and skips", () => {
  const d = bundle();
  put(d, "Dockerfile", "FROM x\nCOPY scripts /app/scripts\n");
  const h1 = buildInputsHash(d);
  put(d, "scripts/unused.js", "3");
  assert.notEqual(buildInputsHash(d), h1);
  put(d, "Dockerfile", "FROM x\nCOPY scripts/*.py /app/\n");
  const g1 = buildInputsHash(d);
  put(d, ".env", "SECRET=9\n");
  put(d, "node_modules/z/index.js", "x");
  assert.equal(buildInputsHash(d), g1);
  put(d, "other.txt", "x");
  assert.notEqual(buildInputsHash(d), g1);
});

test("sources outside the context or via an escaping symlink are not read", () => {
  const d = bundle();
  const outside = mkdtempSync(join(tmpdir(), "bbi-out-"));
  put(outside, "secret.txt", "s1");
  symlinkSync(join(outside, "secret.txt"), join(d, "scripts", "link.txt"));
  put(d, "Dockerfile", "FROM x\nCOPY ../x /x\nCOPY scripts/link.txt /l\n");
  const h1 = buildInputsHash(d);
  put(outside, "secret.txt", "s2");
  assert.equal(buildInputsHash(d), h1);
});

test("no build in the compose → null; missing Dockerfile → null", () => {
  const d = mkdtempSync(join(tmpdir(), "bbi-nb-"));
  put(d, "docker-compose.yml", "services:\n  a:\n    image: nginx\n");
  assert.equal(buildInputsHash(d), null);
  const e = bundle();
  put(e, "docker-compose.yml", COMPOSE.replace("dockerfile: Dockerfile", "dockerfile: Nope"));
  assert.equal(buildInputsHash(e), null);
});

test("tracksBuildInputs / containerBuildLabel", () => {
  assert.equal(tracksBuildInputs(COMPOSE), true);
  assert.equal(tracksBuildInputs("services:\n  a:\n    build: .\n"), false);
  assert.equal(BUILD_INPUTS_LABEL, "crow.build-inputs");
  assert.equal(containerBuildLabel({ Labels: "a=b,crow.build-inputs=abc123,com.docker.compose.project=x" }), "abc123");
  assert.equal(containerBuildLabel({ Labels: { "crow.build-inputs": "def" } }), "def");
  assert.equal(containerBuildLabel({ Labels: "a=b" }), "");
  assert.equal(containerBuildLabel({}), "");
});

test(".dockerignore is part of the hash; a same-content rewrite (new mtime) keeps it", async () => {
  const d = bundle();
  const h1 = buildInputsHash(d);
  put(d, ".dockerignore", ".env\n");
  const h2 = buildInputsHash(d);
  assert.notEqual(h2, h1);
  await new Promise((r) => setTimeout(r, 20));
  put(d, "scripts/a.py", "print(1)\n"); // same content, new mtime: re-read, same answer
  assert.equal(buildInputsHash(d), h2);
  put(d, "scripts/a.py", "print(3)\n");
  assert.notEqual(buildInputsHash(d), h2, "the cache never hides a content change with a new mtime");
});

test("over the size bound the answer is unknown (null), never a guess", () => {
  const d = bundle();
  put(d, "Dockerfile", "FROM x\nCOPY big /big\n");
  put(d, "big", Buffer.alloc(33 * 1024 * 1024));
  assert.equal(buildInputsHash(d), null);
});
