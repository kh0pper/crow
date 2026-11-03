// scripts/hooks/pre-push: which commit messages a push is checked for. A
// fast-forward scans what is new since the remote head; a rebase or force push
// scans only from where the branch leaves main (scanning remote..local there
// would re-check main's own, already public, messages). Runs the real hook in a
// throwaway repo, with a stub hygiene script that records its arguments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "prepush-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).toString().trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "scripts", "hooks"), { recursive: true });
  copyFileSync(join(REPO, "scripts", "hooks", "pre-push"), join(dir, "scripts", "hooks", "pre-push"));
  chmodSync(join(dir, "scripts", "hooks", "pre-push"), 0o755);
  // The stub records each --messages range it is given.
  writeFileSync(join(dir, "scripts", "check-public-hygiene.mjs"),
    'import { appendFileSync } from "node:fs";\n'
    + 'const i = process.argv.indexOf("--messages");\n'
    + 'appendFileSync(process.env.RANGES_OUT, (i > 0 ? process.argv[i + 1] : "(none)") + "\\n");\n');
  let n = 0;
  // One file per commit, so a rebase never conflicts.
  const commit = (msg) => { const f = "f" + (++n) + ".txt"; writeFileSync(join(dir, f), msg); git("add", f); git("commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };
  const out = join(dir, "ranges.txt");
  const push = (localSha, remoteSha, { expectFail = false } = {}) => {
    writeFileSync(out, "");
    try {
      execFileSync("bash", [join(dir, "scripts", "hooks", "pre-push")], {
        cwd: dir, input: `refs/heads/b ${localSha} refs/heads/b ${remoteSha}\n`,
        env: { ...process.env, RANGES_OUT: out }, stdio: ["pipe", "pipe", "pipe"],
      });
      if (expectFail) throw new Error("the hook was expected to refuse");
    } catch (e) {
      if (!expectFail) throw e;
      return { refused: true, ranges: readFileSync(out, "utf8").trim(), stderr: String(e.stderr || "") };
    }
    return readFileSync(out, "utf8").trim();
  };
  return { dir, git, commit, push, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ZERO = "0".repeat(40);

test("a fast-forward push scans what is new since the remote head", () => {
  const r = makeRepo();
  try {
    const base = r.commit("main 1");
    r.git("update-ref", "refs/remotes/origin/main", base);
    r.git("checkout", "-q", "-b", "b");
    const one = r.commit("branch 1");
    const two = r.commit("branch 2");
    assert.equal(r.push(two, one), `${one}..${two}`);
  } finally { r.cleanup(); }
});

test("a rebased push scans only from where the branch leaves main, not main's own messages", () => {
  const r = makeRepo();
  try {
    r.commit("main 1");
    r.git("checkout", "-q", "-b", "b");
    const oldTip = r.commit("branch 1");             // pushed before
    r.git("checkout", "-q", "main");
    const main2 = r.commit("main 2 (already public)");
    r.git("update-ref", "refs/remotes/origin/main", main2);
    r.git("checkout", "-q", "b");
    r.git("rebase", "-q", "main");
    const newTip = r.git("rev-parse", "HEAD");
    const range = r.push(newTip, oldTip);
    assert.equal(range, `${main2}..${newTip}`, "merge-base(origin/main, local)..local");
    const scanned = r.git("log", "--format=%s", range);
    assert.ok(!scanned.includes("main 2"), "main's own message is not re-checked: " + scanned);
    assert.ok(scanned.includes("branch 1"), "the branch's own message is checked");
  } finally { r.cleanup(); }
});

test("a new branch scans from where it leaves main", () => {
  const r = makeRepo();
  try {
    const base = r.commit("main 1");
    r.git("update-ref", "refs/remotes/origin/main", base);
    r.git("checkout", "-q", "-b", "b");
    const tip = r.commit("branch 1");
    assert.equal(r.push(tip, ZERO), `${base}..${tip}`);
  } finally { r.cleanup(); }
});

test("with no origin/main the hook refuses instead of skipping the messages", () => {
  const r = makeRepo();
  try {
    r.commit("main 1");
    r.git("checkout", "-q", "-b", "b");
    const tip = r.commit("branch 1");
    const res = r.push(tip, ZERO, { expectFail: true });
    assert.equal(res.refused, true);
    assert.equal(res.ranges, "", "no scan ran with a made-up range");
    assert.match(res.stderr, /git fetch origin/);
  } finally { r.cleanup(); }
});

test("a branch with no history in common with main scans the whole branch", () => {
  const r = makeRepo();
  try {
    const base = r.commit("main 1");
    r.git("update-ref", "refs/remotes/origin/main", base);
    r.git("checkout", "-q", "--orphan", "lone");
    const tip = r.commit("lone 1");
    assert.equal(r.push(tip, ZERO), `origin/main..${tip}`, "an empty merge-base falls back to origin/main..local");
  } finally { r.cleanup(); }
});
