// Research fetch-before-cite, PR 2: the research skills and the crow.md seed
// teach the loop (search snippets are leads; Crow opens the page; cite only
// what Crow fetched) and declare the crow-projects tools the loop needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillMeta } from "../servers/gateway/skills-catalog.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const pipeline = read("skills/research-pipeline.md");
const webSearch = read("skills/web-search.md");

test("research-pipeline declares its tools", () => {
  assert.deepEqual(parseSkillMeta(pipeline, "en", "research-pipeline").tools, [
    "crow-projects/crow_web_search",
    "crow-projects/crow_add_source",
    "crow-projects/crow_fetch_source",
    "crow-projects/crow_get_source",
    "crow-projects/crow_list_sources",
    "crow-projects/crow_search_sources",
    "crow-projects/crow_add_note",
    "crow-projects/crow_search_notes",
    "crow-projects/crow_verify_source",
    "crow-projects/crow_generate_bibliography",
    "crow-projects/crow_create_project",
    "crow-projects/crow_list_projects",
  ]);
});

test("web-search declares its tools", () => {
  assert.deepEqual(parseSkillMeta(webSearch, "en", "web-search").tools, [
    "crow-projects/crow_web_search",
    "crow-projects/crow_add_source",
    "brave-search",
  ]);
});

test("research-pipeline teaches the loop", () => {
  for (const word of ["crow_web_search", "crow_add_source", "crow_add_note", "crow_verify_source", "provenance", "derived", "snippet", "NOT citable"]) {
    assert.ok(pipeline.includes(word), `mentions ${word}`);
  }
  assert.ok(!/always include APA/i.test(pipeline));
  // The stale verification workflow ("check if the URL is still accessible") is gone.
  assert.ok(!pipeline.includes("Check if the URL is still accessible"));
});

test("research-pipeline covers every crow_add_source outcome and never says to fix a quote", () => {
  for (const line of ["CITABLE: Crow fetched this page.", "NOT citable: Crow could not open this page", "Source already exists (id:",
    "NOT citable yet: this Crow is waiting for a schema upgrade", "Not a web page", "no text Crow can read"]) {
    assert.ok(pipeline.includes(line), `covers ${line}`);
  }
  // A quote note cannot be removed, so "fix the wording" would leave the source unverifiable.
  assert.ok(!/fix the wording/i.test(pipeline));
  assert.ok(pipeline.includes("character for character"));
  assert.ok(pipeline.includes("tell the owner"));
  assert.ok(pipeline.includes("1,200 characters"));
});

test("web-search no longer turns results into sources", () => {
  assert.ok(!webSearch.includes("Every valuable search result should be documented"));
  assert.ok(webSearch.includes("leads, not sources"));
  assert.ok(!/For each valuable result:\s*\n\s*a\. Add to research pipeline/.test(webSearch));
});

test("the crow.md seed says cite only fetched sources", () => {
  const seed = read("scripts/init-db.js");
  assert.ok(seed.includes("- Add sources with \\`crow_add_source\\`, which opens the page first. Cite only sources Crow fetched; a search snippet is a lead, never a citation."));
  assert.ok(seed.includes("2. **Cite only what Crow fetched**: every claim rests on a page Crow opened, or says it is derived."));
  assert.ok(!seed.includes("always include APA citations"));
  assert.ok(!seed.includes("Every external source gets an APA citation"));
  assert.ok(!seed.includes("Every external source gets a citation — no exceptions"));
  assert.ok(!seed.includes("Verify sources before marking as verified"));
  assert.ok(seed.includes("- Only \\`crow_verify_source\\` marks a source verified; never call a source verified unless it said so"));
  assert.ok(seed.includes('| "research", "find papers", "cite" | research-pipeline | crow-projects |\n'));
});

test("docs/skills/index.md lists both skills' new descriptions", () => {
  const index = read("docs/skills/index.md");
  for (const [text, file] of [[pipeline, "research-pipeline.md"], [webSearch, "web-search.md"]]) {
    const desc = text.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    assert.ok(desc, `${file} has a frontmatter description`);
    assert.ok(index.includes(`| \`${file}\` | ${desc} |`), `index row for ${file} is current`);
  }
});
