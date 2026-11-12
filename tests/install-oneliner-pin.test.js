// Guard: every documented one-liner installs the SAME release the installer
// script pins. The default in scripts/crow-install.sh is the source of truth;
// the README, the getting-started pages (English + Spanish), the auto-update
// guide and the installer's own usage comment must all name it.
//
// A `/main/` URL (or any other ref) fails here — that is the point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const INSTALLER = join(ROOT, "scripts", "crow-install.sh");

// The documented one-liner URL, capturing the ref segment.
const ONE_LINER = /raw\.githubusercontent\.com\/kh0pper\/crow\/([^\s/]+)\/scripts\/crow-install\.sh/g;

const PINNED_FILES = [
  "README.md",
  "docs/getting-started/home-server.md",
  "docs/getting-started/oracle-cloud.md",
  "docs/getting-started/windows-wsl2.md",
  "docs/getting-started/raspberry-pi.md",
  "docs/guide/auto-update.md",
  "docs/es/getting-started/home-server.md",
  "docs/es/getting-started/oracle-cloud.md",
  "docs/es/getting-started/windows-wsl2.md",
  "docs/es/getting-started/raspberry-pi.md",
  "docs/es/guide/auto-update.md",
  "scripts/crow-install.sh",
];

function defaultRef() {
  const m = readFileSync(INSTALLER, "utf-8").match(/CROW_INSTALL_REF="\$\{CROW_INSTALL_REF:-([^}]+)\}"/);
  assert.ok(m, 'scripts/crow-install.sh must define CROW_INSTALL_REF="${CROW_INSTALL_REF:-<release>}"');
  return m[1];
}

function refsIn(text) {
  return [...text.matchAll(new RegExp(ONE_LINER.source, "g"))].map((m) => m[1]);
}

test("the installer's pinned release is a plausible tag", () => {
  const ref = defaultRef();
  assert.match(ref, /^v\d+\.\d+\.\d+$/, `CROW_INSTALL_REF default should be a release tag, got ${ref}`);
});

test("every documented one-liner installs the pinned release", () => {
  const ref = defaultRef();
  for (const file of PINNED_FILES) {
    const refs = refsIn(readFileSync(join(ROOT, file), "utf-8"));
    assert.ok(refs.length > 0, `${file} must document the crow-install.sh one-liner`);
    for (const r of refs) {
      assert.equal(r, ref, `${file} installs ${r} but scripts/crow-install.sh pins ${ref}`);
    }
  }
});

test("no other doc still ships the /main/ one-liner", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".vitepress") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!p.endsWith(".md")) continue;
      const refs = refsIn(readFileSync(p, "utf-8"));
      const bad = refs.filter((r) => r === "main");
      if (bad.length) offenders.push(p.slice(ROOT.length + 1));
    }
  };
  walk(join(ROOT, "docs"));
  const readme = refsIn(readFileSync(join(ROOT, "README.md"), "utf-8"));
  if (readme.includes("main")) offenders.push("README.md");
  assert.deepEqual(offenders, [], "these files still install the tip of main");
});