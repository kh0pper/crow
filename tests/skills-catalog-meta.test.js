// Skills panel option C, PR 1: parseSkillMeta reads a skill file's friendly
// title, one-line purpose, triggers and tools (audit A6/A7: 113 of 144 files
// carry a YAML description the panel never read, and titles showed raw slugs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillMeta } from "../servers/gateway/skills-catalog.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("YAML-only purpose with a heading title (the kiosk shape)", () => {
  const m = parseSkillMeta("---\nname: kiosk\ndescription: Put a message or a note on the household kiosk display(s).\n---\n# Kiosk display\n\nBody.\n", "en", "kiosk");
  assert.equal(m.title, "Kiosk display");
  assert.equal(m.description, "Put a message or a note on the household kiosk display(s).");
  assert.equal(m.experimental, false);
});

test("heading-only file: 'Skill' is dropped and the first paragraph is the purpose (the tutoring shape)", () => {
  const m = parseSkillMeta("# Tutoring Skill\n\nSocratic tutoring with progress tracking via **persistent** memory.\n\n## When\n- x\n", "en", "tutoring");
  assert.equal(m.title, "Tutoring");
  assert.equal(m.description, "Socratic tutoring with progress tracking via persistent memory.");
});

test("feature tags, (Experimental) and em-dash subtitles are cleaned from the title", () => {
  assert.equal(parseSkillMeta("# Crow Cross-Posting (F.12.2)\n", "en", "crow-crosspost").title, "Crow Cross-Posting");
  const teams = parseSkillMeta("# Microsoft Teams Skill (Experimental)\n", "en", "microsoft-teams");
  assert.equal(teams.title, "Microsoft Teams");
  assert.equal(teams.experimental, true);
  assert.equal(parseSkillMeta("# Onboarding Skill — First-Run Sharing Setup\n", "en", "onboarding").title, "Onboarding");
  assert.equal(parseSkillMeta("# Cross-Platform Context (crow.md) — Skill\n", "en", "context-management").title, "Cross-Platform Context (crow.md)");
});

test("no heading: a YAML name that is not the slug, else the humanised slug", () => {
  assert.equal(parseSkillMeta("---\nname: Poster maker\n---\nbody\n", "en", "design-poster").title, "Poster maker");
  assert.equal(parseSkillMeta("---\nname: design-poster\ndescription: Make posters.\n---\n\nModified from x.\n", "en", "design-poster").title, "Design poster");
  assert.equal(parseSkillMeta("", "en", "my-own_thing").title, "My own thing");
});

test("name_es / description_es are used for es, with an English fallback", () => {
  const text = "---\nname: Kiosk\nname_es: Pantalla del quiosco\ndescription: Put a note on the kiosk.\ndescription_es: Pon una nota en el quiosco.\n---\n";
  const es = parseSkillMeta(text, "es", "kiosk");
  assert.equal(es.title, "Pantalla del quiosco");
  assert.equal(es.description, "Pon una nota en el quiosco.");
  assert.equal(es.titleLang, "es");
  assert.equal(es.descriptionLang, "es");
  const en = parseSkillMeta(text, "en", "kiosk");
  assert.equal(en.title, "Kiosk");
  const fallback = parseSkillMeta("# Tutoring Skill\n\nTeach.\n", "es", "tutoring");
  assert.equal(fallback.title, "Tutoring");
  assert.equal(fallback.titleLang, "en", "English text on an es page is tagged so");
  assert.equal(fallback.descriptionLang, "en");
});

test("triggers and tools: inline lists, block lists, quoted strings, allowed-tools", () => {
  const a = parseSkillMeta('---\ntriggers: ["poster", \'flyer\', cover art]\nallowed-tools: ["a","b"]\n---\n# X\n', "en", "x");
  assert.deepEqual(a.triggers, ["poster", "flyer", "cover art"]);
  assert.deepEqual(a.tools, ["a", "b"]);
  const b = parseSkillMeta("---\ndescription: \"Quoted: with a colon\"\ntriggers:\n  - back up\n  - restore\ntools: []\n---\n# Backup\n", "en", "backup");
  assert.deepEqual(b.triggers, ["back up", "restore"]);
  assert.deepEqual(b.tools, []);
  assert.equal(b.description, "Quoted: with a colon");
});

test("broken YAML and odd inputs never throw", () => {
  for (const text of ["---\nname: [unclosed\ndescription: \"open\n", "---\n---\n", "---", null, undefined, 42, "﻿# Bom title\n"]) {
    assert.doesNotThrow(() => parseSkillMeta(text, "en", "slug"));
  }
  assert.equal(parseSkillMeta("﻿# Bom title\n", "en", "slug").title, "Bom title");
});

test("a long purpose is cut at a word boundary near 160 characters", () => {
  const long = "word ".repeat(60).trim();
  const m = parseSkillMeta(`---\ndescription: ${long}\n---\n`, "en", "x");
  assert.ok(m.description.length <= 161, String(m.description.length));
  assert.ok(m.description.endsWith("…"));
  assert.ok(!/\s…$/.test(m.description));
});

test("the purpose skips headings, lists, tables, code fences and blockquotes", () => {
  const m = parseSkillMeta("# T\n\n## Sub\n\n- item\n| a | b |\n```\ncode\n```\n> quote\n\nThe [real](https://example.invalid) purpose, with `code`.\n", "en", "t");
  assert.equal(m.description, "The real purpose, with code.");
});

test("every shipped skill file yields a friendly, non-empty title (A6 guard)", () => {
  const files = [];
  for (const f of readdirSync(join(ROOT, "skills"))) if (f.endsWith(".md")) files.push(join(ROOT, "skills", f));
  for (const b of readdirSync(join(ROOT, "bundles"))) {
    const dir = join(ROOT, "bundles", b, "skills");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".md")) files.push(join(dir, f));
  }
  assert.ok(files.length > 100, `found ${files.length} skill files`);
  const raw = [];
  for (const p of files) {
    const slug = p.split("/").pop().replace(/\.md$/, "");
    const text = readFileSync(p, "utf8");
    const m = parseSkillMeta(text, "en", slug);
    assert.ok(m.title && m.title.trim(), `empty title for ${p}`);
    const hasName = /^#\s+\S/m.test(text) || new RegExp(`^name:\\s*(?!${slug}\\s*$)\\S`, "m").test(text);
    if (hasName && m.title === slug) raw.push(p);
  }
  assert.deepEqual(raw, [], "titles that are a raw slug although the file names itself");
});
