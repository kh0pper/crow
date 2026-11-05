/**
 * The Layer 1 documentation, in both languages.
 *
 * `docs/guide/auto-update.md` ("Automatic rollback" → Layer 1) is the only place
 * an operator can learn what the boot guard refuses and how to recover from a
 * refusal alert. Half-documented is worse than undocumented: the failure mode it
 * covers is a gateway that will not start, so the recovery steps have to be in
 * the language the operator reads.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/** The commands a refusal alert tells the operator to run. Present in both. */
const RECOVERY_STEPS = ["git reset --keep", "systemctl"];

for (const [lang, files] of [
  ["en", { update: "docs/guide/auto-update.md", nest: "docs/guide/crows-nest.md" }],
  ["es", { update: "docs/es/guide/auto-update.md", nest: "docs/es/guide/crows-nest.md" }],
]) {
  test(`${lang}: the auto-update guide documents the boot guard and its refusals`, () => {
    const doc = read(files.update);
    assert.match(doc, /### .*\{#boot-guard\}/, "the anchor .crows-nest links to must exist");
    assert.match(doc, /boot-guard\/crow-boot-guard\.mjs/, "the launcher's installed path is named");
    assert.match(doc, /install-boot-guard\.sh/, "the operator is told how to install it");
    assert.match(doc, /index\.lock/);
    assert.match(doc, /init-db\.js/);
    assert.match(doc, /origin\/main/);
    for (const step of RECOVERY_STEPS) assert.ok(doc.includes(step), `${lang} doc is missing "${step}"`);
    assert.match(doc, /Layer 1|Capa 1/);
  });

  test(`${lang}: the user-unit guide installs the boot guard next to the unit`, () => {
    const doc = read(files.nest);
    assert.match(doc, /install-boot-guard\.sh --user/);
    assert.match(doc, /10-boot-guard\.conf/);
    assert.match(doc, /CROW_BOOT_GUARD=1/);
    assert.match(doc, /node:sqlite|22\.13/, "the launcher's Node floor is stated");
  });
}

test("both languages agree on the drop-in name and the launcher path", () => {
  const en = read("docs/guide/auto-update.md") + read("docs/guide/crows-nest.md");
  const es = read("docs/es/guide/auto-update.md") + read("docs/es/guide/crows-nest.md");
  for (const token of ["10-boot-guard.conf", "crow-boot-guard.mjs", "ExecStopPost"]) {
    assert.ok(en.includes(token), `en docs lost ${token}`);
    assert.ok(es.includes(token), `es docs lost ${token}`);
  }
});

test("both languages state the threat model and the permanent refusals", () => {
  // The guard protects against accidents, not against a commit that is out to get
  // the host; and a refusal that cannot clear on its own is not re-armed. Both
  // are operator-facing facts, so neither may exist in one language only.
  const en = read("docs/guide/auto-update.md");
  const es = read("docs/es/guide/auto-update.md");
  assert.match(en, /deliberately malicious commit/);
  assert.match(es, /deliberadamente[\s\S]{0,40}malicioso/);
  assert.match(en, /does \*\*not\*\* re-arm the same commit/);
  assert.match(es, /\*\*no\*\* vuelve a armar el mismo commit/);
});