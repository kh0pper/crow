// The Perch tool chip says what happened in the operator's words, not the
// engine's ids ("mcp__brave-search__brave_web_search" on a phone is noise), and
// keeps the raw id on its title so it is still reachable on hover/long-press.
//
// The client script is a string, so toolDisplayName and appendToolChip are
// lifted out of it with new Function(...) — the pattern perch-hub-client.test.js
// uses — and the chip is rendered against a minimal fake DOM. Nothing here
// re-proves what a real browser does with textContent; that is the render
// suite's job.
import { test } from "node:test";
import assert from "node:assert/strict";
import { perchHubJs } from "../servers/gateway/dashboard/perch-hub/client.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

/** Comments blanked (same length, newlines kept), so a brace inside one cannot
 *  unbalance the depth counter. */
function maskComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Index of the "}" that closes the first block opened at or after `start`. */
function braceMatchEnd(src, start) {
  const masked = maskComments(src);
  let depth = 0, end = -1;
  for (let i = masked.indexOf("{", start); i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") { depth--; if (!depth) { end = i; break; } }
  }
  return end;
}

/** The emitted `var TOOL_N={...}` declaration, so these tests read the strings
 *  the browser actually gets rather than the i18n table behind them. */
function toolNDecl(lang) {
  const src = perchHubJs(lang);
  const start = src.indexOf("var TOOL_N=");
  assert.ok(start > -1, "TOOL_N must be declared in the emitted script");
  return src.slice(start, braceMatchEnd(src, start) + 1);
}

/** toolDisplayName as the page runs it, in one language. */
function displayName(lang) {
  const src = perchHubJs(lang);
  // The helpers (TOOL_SERVERS … toolToolName) sit just above toolDisplayName: lift them together.
  const from = src.indexOf("var TOOL_SERVERS=");
  const start = src.indexOf("function toolDisplayName");
  assert.ok(from > -1 && start > from, "toolDisplayName and its helpers must be in the emitted script");
  return new Function(toolNDecl(lang) + "\n" +
    src.slice(from, braceMatchEnd(src, start) + 1) + "; return toolDisplayName;")();
}

/** Just enough DOM for appendToolChip: children, classes, attributes, text. */
function fakeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(), className: "", textContent: "", children: [], attrs: {},
    hidden: false, type: "", scrollTop: 0, scrollHeight: 0,
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
    get firstChild() { return this.children[0] || null; },
  };
}

/** Mount appendToolChip against a fake transcript and return what it drew. */
function renderChip(lang, data) {
  const src = perchHubJs(lang);
  const start = src.indexOf("function appendToolChip");
  assert.ok(start > -1, "appendToolChip must be in the emitted script");
  const body = src.slice(start, braceMatchEnd(src, start) + 1);

  const transcript = fakeElement("div");
  const document = {
    createElement: (tag) => fakeElement(tag),
    getElementById: (id) => (id === "perch-transcript" ? transcript : null),
  };
  const el = (id) => document.getElementById(id);
  const line = (cls, text) => {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = text == null ? "" : String(text);
    return d;
  };

  const make = new Function("document", "el", "line", "toolChips", "TOOL_RUNNING",
    "TOOL_DONE", "TOOL_FAILED", "toolDisplayName",
    toolNDecl(lang) + "\n" + body + "\nreturn appendToolChip;");
  const appendToolChip = make(document, el, line, {},
    t("perch.toolRunning", lang), t("perch.toolDone", lang), t("perch.toolFailed", lang),
    displayName(lang));

  appendToolChip(data);
  const wrap = transcript.children[0];
  assert.ok(wrap, "the chip must land in the transcript");
  const chip = wrap.children[0];
  const tn = chip.children.find((c) => c.className === "tn");
  assert.ok(tn, "the chip carries its name node");
  return { chip, tn, wrap };
}

test("an MCP tool id reads as Server · Tool", () => {
  const name = displayName("en");
  assert.equal(name("mcp__brave-search__brave_web_search"), "Brave Search \u00b7 Web search");
  assert.equal(name("mcp__crow-memory__crow_search_memories"), "Memory \u00b7 Search memories");
  assert.equal(name("mcp__some-addon__do_thing"), "Some addon \u00b7 Do thing",
    "an add-on with no entry in the map is still spelled out from its id");
  // The server's own prefix is not repeated on the right-hand side.
  assert.equal(name("mcp__browser__crow_browser_navigate"), "Browser \u00b7 Navigate");
  assert.equal(name("mcp__monday__monday_list_items"), "monday.com \u00b7 List items");
});

test("pi's built-in tools read as the page's own strings, never as ids", () => {
  const en = displayName("en");
  const keys = {
    bash: "perch.toolNameBash", read: "perch.toolNameRead", edit: "perch.toolNameEdit",
    write: "perch.toolNameWrite", grep: "perch.toolNameGrep", find: "perch.toolNameFind",
    ls: "perch.toolNameLs",
  };
  for (const [id, key] of Object.entries(keys)) {
    assert.equal(en(id), t(key, "en"), id + " must read as " + key);
  }
  assert.equal(en("bash"), "Shell command");
  assert.equal(en("read"), "Read a file");
});

test("anything else drops a leading crow_ and reads as words", () => {
  const name = displayName("en");
  assert.equal(name("board_create_item"), "Board create item");
  assert.equal(name("crow_search_memories"), "Search memories");
  assert.equal(name("subagent"), "Subagent");
});

test("an empty or missing name still reads as ?", () => {
  const name = displayName("en");
  for (const raw of ["", null, undefined]) {
    assert.equal(name(raw), "?", JSON.stringify(raw));
  }
});

test("a 200-character name is capped for a 390px chip", () => {
  const name = displayName("en");
  const long = "x".repeat(200);
  assert.equal(name(long).length, 60);
  assert.ok(name("mcp__" + "a".repeat(120) + "__" + "b".repeat(120)).length <= 60,
    "a long MCP id cannot push the chip wider than its cap either");
});

test("Spanish reads in Spanish", () => {
  assert.equal(displayName("es")("bash"), "Comando de terminal");
  assert.equal(displayName("es")("read"), "Leer un archivo");
});

test("the chip shows the friendly name and carries the raw id on its title", () => {
  const raw = "mcp__brave-search__brave_web_search";
  const { chip, tn } = renderChip("en", { name: raw, toolCallId: "c1" });
  assert.equal(tn.textContent, "Brave Search \u00b7 Web search");
  assert.equal(chip.getAttribute("title"), raw,
    "the id the engine uses is still reachable on hover / long-press");
  assert.equal(chip.children.length, 3, "spinner + name + status, as before");
});

test("a raw name carrying markup is written as TEXT, never as elements", () => {
  const raw = "board_<b>x</b>";
  const { chip, tn } = renderChip("en", { name: raw, toolCallId: "h1" });
  assert.equal(tn.textContent, "Board <b>x</b>");
  assert.equal(tn.children.length, 0, "the name node has no parsed children");
  assert.equal(chip.children.length, 3, "nothing was injected into the chip");
  assert.equal(chip.getAttribute("title"), raw, "and the title keeps the raw bytes as a string");
});

test("the chip renderer has no markup sink at all", () => {
  const src = perchHubJs("en");
  const start = src.indexOf("function appendToolChip");
  const body = src.slice(start, braceMatchEnd(src, start) + 1);
  assert.doesNotMatch(body, /innerHTML|outerHTML|insertAdjacentHTML/,
    "textContent only: the raw id is child-adjacent bytes");
});

test("a server or tool id that is an Object.prototype name reads as words, never as function source", () => {
  const name = displayName("en");
  for (const raw of ["mcp__constructor__x", "mcp__toString__y", "constructor"]) {
    const out = name(raw);
    assert.doesNotMatch(out, /function|native code|\{/, raw);
  }
});
