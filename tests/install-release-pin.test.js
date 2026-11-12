// The one-line installer pins a RELEASE (CROW_INSTALL_REF) instead of cloning
// the tip of main, but must leave the checkout on a LOCAL branch named `main`
// with upstream origin/main: the gateway's auto-updater only pulls when HEAD is
// the branch `main` (servers/gateway/auto-update.js), so a detached tag
// checkout would never update again.
//
// Everything here runs against local scratch repositories — no network, no
// clone of the real project.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "crow-install.sh");

/** Source the installer's helper layer (CROW_INSTALL_SOURCE_ONLY=1) and run a
 *  snippet against it. detached:true puts the child in a new session with no
 *  controlling terminal, so the /dev/tty probe fails exactly as it does for
 *  the documented `curl … | bash` one-liner. */
function runWithHelpers(snippet, env = {}) {
  return spawnSync("bash", ["-c", `set -euo pipefail; CROW_INSTALL_SOURCE_ONLY=1 source "${SCRIPT}"; ${snippet}`], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
}

/** git with an identity and a default branch supplied by -c flags, so the
 *  suite's own ~/.gitconfig can never decide the branch name or fail a commit. */
function git(cwd, ...args) {
  return execFileSync("git", [
    "-c", "user.name=Crow Test",
    "-c", "user.email=crow-test@example.invalid",
    "-c", "init.defaultBranch=main",
    "-c", "commit.gpgsign=false",
    "-c", "tag.gpgsign=false",
    "-C", cwd,
    ...args,
  ], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A bare "remote" whose main is two commits ahead of its v9.9.9 tag:
 *  A (tagged v9.9.9) → B (tip of main). Returns commit ids A and B. */
function makeReleaseFixture() {
  const root = mkdtempSync(join(tmpdir(), "crow-release-pin-"));
  const work = join(root, "work");
  const bare = join(root, "crow.git");

  git(root, "init", "-q", "work");
  git(work, "commit", "-q", "--allow-empty", "-m", "A");
  git(work, "tag", "v9.9.9");
  const a = git(work, "rev-parse", "HEAD").trim();

  writeFileSync(join(work, "marker.txt"), "B\n");
  git(work, "add", "marker.txt");
  git(work, "commit", "-q", "-m", "B");
  const b = git(work, "rev-parse", "HEAD").trim();

  git(root, "init", "-q", "--bare", "crow.git");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-q", "origin", "main");
  git(work, "push", "-q", "origin", "v9.9.9");

  return { root, bare, a, b };
}

test("clone_crow_release installs the pinned tag on a local main tracking origin/main", () => {
  const { root, bare, a, b } = makeReleaseFixture();
  const dest = join(root, "app");

  const r = runWithHelpers(`clone_crow_release "${dest}"`, {
    CROW_REPO_URL: bare,
    CROW_INSTALL_REF: "v9.9.9",
    HOME: root,
  });
  assert.equal(r.status, 0, `clone_crow_release failed:\n${r.stdout}\n${r.stderr}`);

  // The working tree is the tag's commit, not main's tip.
  assert.equal(git(dest, "rev-parse", "HEAD").trim(), a, "HEAD must be the tagged commit");
  // …on a real branch named main, never detached.
  assert.equal(git(dest, "symbolic-ref", "--short", "HEAD").trim(), "main");
  // …that tracks origin/main, so the updater's `git pull --ff-only` works.
  assert.equal(git(dest, "rev-parse", "--abbrev-ref", "main@{upstream}").trim(), "origin/main");

  // Proof the arrangement is what the updater needs: a fast-forward to main.
  git(dest, "pull", "-q", "--ff-only", "origin", "main");
  assert.equal(git(dest, "rev-parse", "HEAD").trim(), b, "pull --ff-only origin main must land on the tip of main");
});

test("CROW_INSTALL_REF=main keeps today's plain clone (tip of main)", () => {
  const { root, bare, b } = makeReleaseFixture();
  const dest = join(root, "app");

  const r = runWithHelpers(`clone_crow_release "${dest}"`, {
    CROW_REPO_URL: bare,
    CROW_INSTALL_REF: "main",
    HOME: root,
  });
  assert.equal(r.status, 0, `clone_crow_release failed:\n${r.stdout}\n${r.stderr}`);

  assert.equal(git(dest, "rev-parse", "HEAD").trim(), b);
  assert.equal(git(dest, "symbolic-ref", "--short", "HEAD").trim(), "main");
});

test("CROW_INSTALL_REF is validated at source time: option-like, '..' and whitespace refs exit non-zero", () => {
  for (const bad of ["--upload-pack=x", "a..b", "x y", "-x", "/main"]) {
    const r = runWithHelpers(":", { CROW_INSTALL_REF: bad });
    assert.notEqual(r.status, 0, `CROW_INSTALL_REF=${JSON.stringify(bad)} must be rejected`);
    assert.match(r.stderr + r.stdout, /Invalid CROW_INSTALL_REF/, `expected an error for ${JSON.stringify(bad)}`);
  }
});

test("CROW_INSTALL_REF accepts the shapes the docs and the checklist use", () => {
  for (const good of ["v1.1.0", "main", "v9.9.9", "abc123", "release/1.1"]) {
    const r = runWithHelpers(":", { CROW_INSTALL_REF: good });
    assert.equal(r.status, 0, `CROW_INSTALL_REF=${good} must be accepted:\n${r.stderr}`);
  }
});