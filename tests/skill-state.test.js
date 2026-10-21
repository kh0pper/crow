// Skills panel option C, PR 2: the per-instance on/off list
// (<CROW_HOME>/skill-state.json). Readers fail OPEN: a garbled file switches
// nothing off. Writers refuse to rewrite a garbled file from scratch.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillState, setSkillOff, offSkills, SKILL_STATE_FILE } from "../servers/shared/skill-state.js";

const scratch = mkdtempSync(join(tmpdir(), "skill-state-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const home = () => { const h = join(scratch, `h${++n}`); mkdirSync(h, { recursive: true }); return h; };

test("a missing file is an empty state", () => {
  const h = home();
  assert.deepEqual(readSkillState(h), { ok: true, state: { version: 1, off: [] } });
  assert.deepEqual([...offSkills(h)], []);
  assert.equal(SKILL_STATE_FILE, "skill-state.json");
});

test("switching off and on round-trips; the file is mode 600 and written atomically", () => {
  const h = home();
  assert.deepEqual(setSkillOff(h, "media", true), { ok: true });
  assert.deepEqual(setSkillOff(h, "Microsoft-Teams.md", true), { ok: true }, "a file name or a mixed-case name normalises");
  assert.deepEqual(setSkillOff(h, "media", true), { ok: true }, "idempotent");
  assert.deepEqual(readSkillState(h).state.off, ["media", "microsoft-teams"]);
  assert.equal(statSync(join(h, SKILL_STATE_FILE)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(h).filter((f) => f.endsWith(".tmp")), []);
  setSkillOff(h, "media", false);
  assert.deepEqual([...offSkills(h)], ["microsoft-teams"]);
});

test("an invalid name is refused and nothing is written", () => {
  const h = home();
  for (const bad of ["../x", "a/b", "", ".hidden", "x".repeat(81), null, 7]) {
    assert.equal(setSkillOff(h, bad, true).ok, false, String(bad));
  }
  assert.equal(existsSync(join(h, SKILL_STATE_FILE)), false);
});

test("a garbled file reads ok:false with nothing off, and a write refuses (byte-identical after)", () => {
  const h = home();
  for (const junk of ["{ not json", "[1,2]", '{"off": "media"}', "null"]) {
    writeFileSync(join(h, SKILL_STATE_FILE), junk);
    const r = readSkillState(h);
    assert.equal(r.ok, false, junk);
    assert.deepEqual(r.state.off, []);
    assert.deepEqual([...offSkills(h)], [], "fail open: bots keep their skills");
    assert.deepEqual(setSkillOff(h, "media", true), { ok: false, error: "unreadable" });
    assert.equal(readFileSync(join(h, SKILL_STATE_FILE), "utf8"), junk);
  }
});

test("unknown keys survive a write (a later PR's ack map is not dropped)", () => {
  const h = home();
  writeFileSync(join(h, SKILL_STATE_FILE), JSON.stringify({ version: 1, off: [], ack: { "x.md": { srcSha: "a" } } }));
  setSkillOff(h, "media", true);
  assert.deepEqual(JSON.parse(readFileSync(join(h, SKILL_STATE_FILE), "utf8")).ack, { "x.md": { srcSha: "a" } });
});

test("two homes are independent (a co-hosted instance has its own list)", () => {
  const a = home(), b = home();
  setSkillOff(a, "media", true);
  assert.deepEqual([...offSkills(a)], ["media"]);
  assert.deepEqual([...offSkills(b)], []);
});

test("a garbled file warns in the journal, once per file version (the fail-open must be visible)", async () => {
  const { utimesSync } = await import("node:fs");
  const h = home();
  writeFileSync(join(h, SKILL_STATE_FILE), "{ garbled");
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    readSkillState(h); readSkillState(h); offSkills(h);
    assert.equal(warns.length, 1, warns.join("\n"));
    assert.match(warns[0], /skill-state\.json can't be read; every skill is treated as on/);
    const later = new Date(Date.now() + 5000);
    utimesSync(join(h, SKILL_STATE_FILE), later, later);
    readSkillState(h);
    assert.equal(warns.length, 2, "a changed file warns again");
    writeFileSync(join(h, SKILL_STATE_FILE), JSON.stringify({ version: 1, off: [] }));
    readSkillState(h);
    assert.equal(warns.length, 2, "a good file is quiet");
  } finally { console.warn = orig; }
});

test("ackSkill records 'keep mine' per shipped version, keeps the off list, and refuses a garbled file", async () => {
  const { ackSkill } = await import("../servers/shared/skill-state.js");
  const h = home();
  setSkillOff(h, "media", true);
  assert.deepEqual(ackSkill(h, "media.md", "abc"), { ok: true });
  assert.deepEqual(ackSkill(h, "Retired.md", null), { ok: true }, "a file name normalises; no shipped version is fine");
  const st = readSkillState(h).state;
  assert.equal(st.ack["media.md"].srcSha, "abc");
  assert.equal(st.ack["retired.md"].srcSha, null);
  assert.match(st.ack["media.md"].at, /^\d{4}-/);
  assert.deepEqual(st.off, ["media"]);
  assert.equal(ackSkill(h, "../x", "a").ok, false);
  writeFileSync(join(h, SKILL_STATE_FILE), "{ garbled");
  const orig = console.warn; console.warn = () => {};
  try { assert.deepEqual(ackSkill(h, "media.md", "x"), { ok: false, error: "unreadable" }); } finally { console.warn = orig; }
});
