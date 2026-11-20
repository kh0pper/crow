/**
 * Static + behavioural guard for the two reporting steps of
 * .github/workflows/image-freshness.yml.
 *
 * Production context (2026-11-20): this workflow ran on a self-hosted Gitea
 * mirror where the repo had NO labels. Gitea IGNORES an unknown `labels:`, so
 * listForRepo({ labels }) answered with EVERY open issue AND pull request, and
 * the failure step rewrote the newest open PR's title and body (the success step
 * would have commented on and closed an arbitrary PR/issue). The fix filters
 * client-side: never a pull request, exact title, and the label when it exists.
 * The job is now gated to GitHub (see the forge-split guards below), which is
 * exactly why the filtering also has to hold against an ordinary GitHub PR that
 * reuses the title.
 *
 * The workflow text is read as text (the repo has no YAML dependency) and each
 * `script:` block is executed against a fake `github`/`context`/`core`, so the
 * "never touch a PR" rule is observed, not just grepped for.
 *
 * It also guards the forge split: Gitea Actions reads .github/workflows/ too, so
 * every job of a GitHub-only workflow (Pages deploy, the nightly image pull)
 * must carry a job-level `if: github.server_url == 'https://github.com'`, while
 * the cross-forge CI (test.yml) must keep every job unguarded — and unnamed, so
 * its job keys stay the branch-protection contexts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOW = ".github/workflows/image-freshness.yml";
const yaml = readFileSync(join(ROOT, WORKFLOW), "utf8");

const TITLE = "Bundle image-freshness check failed";
const LABEL = "bundle-image-stale";

/** Every `script: |` block scalar, with the name of the step it belongs to. */
function scriptBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let step = null;
  for (let i = 0; i < lines.length; i++) {
    const name = /^\s*- name:\s*(.+?)\s*$/.exec(lines[i]);
    if (name) step = name[1];
    const start = /^(\s*)script:\s*\|\s*$/.exec(lines[i]);
    if (!start) continue;
    const indent = start[1].length;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) { body.push(""); continue; }
      if (line.length - line.trimStart().length <= indent) break;
      body.push(line);
    }
    const dedent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    blocks.push({ step, script: body.map((l) => (l.trim() ? l.slice(dedent) : "")).join("\n") });
    i = j - 1;
  }
  return blocks;
}

const blocks = scriptBlocks(yaml);
const failure = blocks.find((b) => /failure/i.test(b.step || ""));
const success = blocks.find((b) => /success/i.test(b.step || ""));

/** The script's code only — the Gitea explanation in comments quotes the old
 *  `open.data[0]`, which must not read as live code. */
const code = (block) => (block.script || "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

// --- static guards ---------------------------------------------------------

test("the workflow has exactly the two reporting steps, both found", () => {
  assert.equal(blocks.length, 2, "expected two github-script steps in " + WORKFLOW);
  assert.ok(failure, "no failure-step script block found");
  assert.ok(success, "no success-step script block found");
});

test("neither step asks the server to filter by label (Gitea ignores it) — it filters client-side", () => {
  for (const block of [failure, success]) {
    const script = code(block);
    const call = /github\.rest\.issues\.listForRepo\(\{([\s\S]*?)\}\);/.exec(script);
    assert.ok(call, `${block.step}: no listForRepo call`);
    assert.ok(!/\blabels\s*:/.test(call[1]), `${block.step}: passes a labels option to listForRepo — Gitea ignores an unknown label filter and then returns every issue AND pull request`);
    assert.ok(/isPinnedIssue/.test(script), `${block.step}: no client-side isPinnedIssue filter`);
  }
});

test("each step filters out pull requests and requires the exact title before update/close", () => {
  for (const block of [failure, success]) {
    const script = code(block);
    assert.ok(/!item\.pull_request/.test(script), `${block.step}: does not exclude item.pull_request`);
    assert.ok(/item\.title === TITLE/.test(script), `${block.step}: does not require the exact TITLE`);
    assert.ok(/hasLabel\(item\)/.test(script), `${block.step}: does not check the label client-side`);
    assert.ok(/labelName\(l\) === LABEL/.test(script), `${block.step}: label check does not compare label names`);
    assert.ok(!/open\.data\[0\]/.test(script), `${block.step}: still trusts the first row of the list`);
    // The filter runs over the list, and every issue_number acted on comes from
    // that filtered set only.
    assert.ok(script.indexOf(".filter((item) => isPinnedIssue") > script.indexOf("listForRepo("), `${block.step}: filter is not applied to the list`);
    const numbers = [...script.matchAll(/issue_number:\s*([^,\n}]+)/g)].map((m) => m[1].trim());
    assert.ok(numbers.length > 0, `${block.step}: nothing is updated`);
    for (const n of numbers) assert.match(n, /^(matches\[0\]|issue)\.number$/, `${block.step}: acts on '${n}' instead of a filtered match`);
  }
});

test("the failure step ensures the label exists and can still file without it", () => {
  const script = code(failure);
  assert.ok(/createLabel\(/.test(script), "failure step never tries to create the missing label");
  assert.ok(/listLabelsForRepo\(/.test(script), "failure step never checks whether the label already exists");
  assert.ok(/labels: \[LABEL\]/.test(script), "failure step never attaches the label when it can");
  assert.ok(/usable \? \{ labels: \[LABEL\] \} : \{\}/.test(script), "failure step must be able to file the issue WITHOUT the label");
  assert.ok(/isPinnedIssue\(item, label\.present\)/.test(script), "failure step must fall back to title-only matching when the label was not there");
});

test("the success step does nothing when nothing matches", () => {
  const script = code(success);
  assert.ok(/matches\.length === 0/.test(script), "success step has no empty-match guard");
  assert.ok(!/createLabel\(/.test(script), "the success step must not create labels");
});

// --- the forge split: GitHub-only jobs are inert on Gitea ------------------

const GITHUB_ONLY = [".github/workflows/deploy-docs.yml", ".github/workflows/image-freshness.yml"];
const CI_WORKFLOW = ".github/workflows/test.yml";
const GUARD = /^ {4}if:.*github\.server_url == 'https:\/\/github\.com'/m;
const readWorkflow = (p) => readFileSync(join(ROOT, p), "utf8");

/**
 * Every job of a workflow as `{ key, header }`, where `header` is the job's own
 * lines up to (not including) its `steps:`/`uses:` list — so a step-level `if:`
 * can never satisfy a job-level check. Read as text: no YAML dependency here.
 */
function workflowJobs(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.notEqual(start, -1, "workflow has no jobs: block");
  const found = [];
  let job = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!/^ /.test(line)) break; // back to a top-level key
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key) { job = { key: key[1], header: [] }; found.push(job); continue; }
    if (!job) continue;
    if (/^ {4}(steps|uses):/.test(line)) { job.closed = true; continue; }
    if (job.closed) continue;
    job.header.push(line);
  }
  return found;
}

test("every job of a GitHub-only workflow carries the github.server_url guard", () => {
  for (const wf of GITHUB_ONLY) {
    const jobs = workflowJobs(readWorkflow(wf));
    assert.ok(jobs.length > 0, `${wf}: no jobs found — the guard check would be vacuous`);
    for (const job of jobs) {
      assert.match(job.header.join("\n"), GUARD, `${wf}: job '${job.key}' has no job-level "if: github.server_url == 'https://github.com'" (combine with && if it ever needs another condition) — Gitea Actions reads this file and the job is not meant to run there`);
    }
  }
});

test("the cross-forge CI (test.yml) keeps every job unguarded and unnamed", () => {
  const jobs = workflowJobs(readWorkflow(CI_WORKFLOW));
  const keys = jobs.map((j) => j.key);
  for (const required of ["suite", "static-checks", "audit"]) {
    assert.ok(keys.includes(required), `test.yml lost the branch-protection job key '${required}' (now: ${keys.join(", ")})`);
  }
  for (const job of jobs) {
    const header = job.header.join("\n");
    assert.doesNotMatch(header, /github\.server_url/, `${CI_WORKFLOW}: job '${job.key}' is guarded to GitHub — this workflow is the CI on both GitHub and Gitea`);
    assert.doesNotMatch(header, /^ {4}name:/m, `${CI_WORKFLOW}: job '${job.key}' sets a job-level name:, which would replace the job key as the status context`);
  }
});

test("test.yml documents the Gitea status contexts", () => {
  const text = readWorkflow(CI_WORKFLOW);
  const header = text.slice(0, text.indexOf("jobs:"));
  for (const key of ["suite", "static-checks", "audit"]) {
    assert.match(header, new RegExp(`\\b${key} \\(pull_request\\)`), `test.yml's header should name the Gitea status context "${key} (pull_request)"`);
  }
});

// --- behavioural guards (the fake Gitea ignores `labels:`, as the real one does) ---

const issue = (number, over = {}) => ({ number, title: TITLE, labels: [{ name: LABEL }], ...over });
const pr = (number, over = {}) => ({ number, title: TITLE, pull_request: { url: "x" }, labels: [{ name: LABEL }], ...over });

function harness({ issues = [], labels = [], createLabelFails = false } = {}) {
  const calls = { update: [], create: [], comment: [], createLabel: [], listForRepo: [] };
  const github = { rest: { issues: {
    // Deliberately ignores any `labels` argument, like Gitea with an unknown label.
    listForRepo: async (args) => { calls.listForRepo.push(args); return { data: issues }; },
    listLabelsForRepo: async () => ({ data: labels.map((name) => ({ name })) }),
    createLabel: async (args) => {
      calls.createLabel.push(args);
      if (createLabelFails) throw new Error("403 Forbidden");
      return { data: { name: args.name } };
    },
    update: async (args) => { calls.update.push(args); return { data: {} }; },
    create: async (args) => { calls.create.push(args); return { data: { number: 42 } }; },
    createComment: async (args) => { calls.comment.push(args); return { data: {} }; },
  } } };
  const context = { serverUrl: "https://gitea.example", repo: { owner: "alex", repo: "crow" }, runId: 7 };
  const core = { info: () => {}, debug: () => {}, warning: () => {} };
  const fakeRequire = (name) => {
    assert.equal(name, "fs");
    return { readFileSync: () => "ghcr.io/example/gone:1\n" };
  };
  return { calls, run: (script) => new Function("github", "context", "core", "require", "return (async () => {\n" + script + "\n})();")(github, context, core, fakeRequire) };
}

test("failure step: a pull request titled TITLE and carrying the label is never touched", async () => {
  const { calls, run } = harness({
    issues: [
      pr(1),
      issue(2, { title: "Something else" }),
      issue(3),
    ],
    labels: [LABEL, "automated"],
  });
  await run(failure.script);

  assert.deepEqual(calls.update.map((c) => c.issue_number), [3], "only the labelled, exactly titled issue is updated");
  assert.equal(calls.update[0].title, TITLE);
  assert.match(calls.update[0].body, /ghcr\.io\/example\/gone:1/);
  assert.deepEqual(calls.create, [], "an existing pinned issue is updated, not duplicated");
  assert.equal(calls.listForRepo[0].labels, undefined, "no server-side label filter is trusted");
});

test("failure step: nothing matches → create the label, then file the issue with it", async () => {
  const { calls, run } = harness({
    issues: [pr(1), issue(2, { title: "Something else" })],
    labels: [],
  });
  await run(failure.script);

  assert.deepEqual(calls.update, [], "no PR and no unrelated issue is retitled");
  assert.equal(calls.createLabel.length, 1);
  assert.equal(calls.createLabel[0].name, LABEL);
  assert.equal(calls.create.length, 1);
  assert.deepEqual(calls.create[0].labels, [LABEL], "the freshly created label is attached");
  assert.equal(calls.create[0].title, TITLE);
});

test("failure step: a label that cannot be created → file without it, and match by exact title later", async () => {
  // No label was creatable, so the pinned issue exists unlabeled.
  const first = harness({ issues: [pr(1)], labels: [], createLabelFails: true });
  await first.run(failure.script);
  assert.equal(first.calls.create.length, 1);
  assert.equal(first.calls.create[0].labels, undefined, "never depends on the label");
  assert.deepEqual(first.calls.update, []);

  // Later run: still no label, the unlabeled pinned issue is found by title.
  const later = harness({ issues: [pr(2), { number: 5, title: TITLE, labels: [] }], labels: [], createLabelFails: true });
  await later.run(failure.script);
  assert.deepEqual(later.calls.update.map((c) => c.issue_number), [5]);
  assert.deepEqual(later.calls.create, []);
});

test("success step: closes only the labelled, exactly titled issue — never a PR", async () => {
  const { calls, run } = harness({
    issues: [pr(1), issue(2), issue(3, { title: "Something else" })],
    labels: [LABEL],
  });
  await run(success.script);

  assert.deepEqual(calls.comment.map((c) => c.issue_number), [2], "no comment on a PR or an unrelated issue");
  assert.deepEqual(calls.update.map((c) => c.issue_number), [2]);
  assert.equal(calls.update[0].state, "closed");
});

test("success step: nothing matches → nothing is commented on or closed", async () => {
  const { calls, run } = harness({
    issues: [pr(1), issue(2, { title: "Something else" }), pr(3, { title: "Unrelated PR" })],
    labels: [LABEL],
  });
  await run(success.script);
  assert.deepEqual(calls.comment, []);
  assert.deepEqual(calls.update, []);
});

test("success step: repo with no labels → the unlabeled pinned issue is still closed, a PR is not", async () => {
  const { calls, run } = harness({
    issues: [pr(1, { labels: [] }), { number: 9, title: TITLE, labels: [] }],
    labels: [],
  });
  await run(success.script);
  assert.deepEqual(calls.comment.map((c) => c.issue_number), [9]);
  assert.deepEqual(calls.update.map((c) => c.issue_number), [9]);
});