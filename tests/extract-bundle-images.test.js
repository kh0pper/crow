// scripts/extract-bundle-images.py feeds the nightly image-freshness workflow a
// list of images to `docker pull`. Local-only images must never reach it, or the
// workflow fails every night on an image no registry has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/extract-bundle-images.py", import.meta.url));
function havePython() {
  try { execFileSync("python3", ["-c", "import yaml"], { stdio: "ignore" }); return true; } catch { return false; }
}

function extract(composes) {
  const dir = mkdtempSync(join(tmpdir(), "extract-images-"));
  try {
    for (const [bundle, yml] of Object.entries(composes)) {
      mkdirSync(join(dir, "bundles", bundle), { recursive: true });
      writeFileSync(join(dir, "bundles", bundle, "docker-compose.yml"), yml);
    }
    execFileSync("python3", [script, "images.txt", "failures.txt"], { cwd: dir, stdio: "ignore" });
    const lines = (f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
    return { images: lines("images.txt"), failures: lines("failures.txt") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const skip = !havePython() && "python3/pyyaml unavailable";

test("a service with pull_policy: never is local-only and is not reported", { skip }, () => {
  const { images, failures } = extract({
    a: "services:\n  app:\n    image: nginx:1.27\n  local:\n    image: some-local:1.0\n    pull_policy: never\n",
  });
  assert.deepEqual(images, ["nginx:1.27"]);
  assert.deepEqual(failures, []);
});

test("a service reusing an image another service in the same compose builds is not reported", { skip }, () => {
  const { images } = extract({
    a: "services:\n  render:\n    build:\n      context: ./r\n    image: kit-renderer:1.0.0\n  door:\n    image: kit-renderer:1.0.0\n  db:\n    image: postgres:16\n",
    // the same tag in ANOTHER bundle with no build is a real pull and stays
    b: "services:\n  x:\n    image: kit-renderer:1.0.0\n",
  });
  assert.deepEqual(images, ["kit-renderer:1.0.0", "postgres:16"]);
});

test("the shipped Design kit compose contributes no pullable image", { skip }, () => {
  const yml = readFileSync(new URL("../bundles/design-kit/docker-compose.yml", import.meta.url), "utf8");
  const { images, failures } = extract({ "design-kit": yml });
  assert.deepEqual(images, []);
  assert.deepEqual(failures, []);
});
