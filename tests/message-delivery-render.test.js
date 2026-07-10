/**
 * message-delivery-render — R2 Task 4. Show delivery state on THREAD RELOAD
 * (persisted `delivery_status`), not just at send time (Task 3 covers the
 * live send-time failure surfacing via markBubbleFailed).
 *
 * (a) QUERY level: getPeerMessages must include delivery_status per row so
 *     the client has it to render on reload.
 * (b) RENDER level: appendBubble (client.js, executed in-browser) must show
 *     — for direction='sent' only — a failed affordance (reusing Task 3's
 *     `msg-bubble-failed` class + note, via markBubbleFailed) when
 *     delivery_status='failed'; a single check for 'relayed'; a double check
 *     for 'delivered'; nothing for null/'pending'. Received messages never
 *     show a delivery indicator.
 *
 * client.js is a big browser-executed template string that self-starts
 * polling/fetch on load, so we don't run the whole thing in a vm — we
 * extract just the functions the render path needs (el, appendBubble,
 * markBubbleFailed) via brace-matching and run those against a minimal
 * hand-rolled DOM stub (no jsdom dependency).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getPeerMessages } from "../servers/gateway/dashboard/panels/messages/data-queries.js";
import { messagesClientJS } from "../servers/gateway/dashboard/panels/messages/client.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "msg-delivery-render-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

async function mkContact(db, { crowId, name = null }) {
  const r = await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, ed25519_pubkey, contact_type)
          VALUES (?,?,?,?, 'crow')`,
    args: [crowId, name, "02" + "a".repeat(64), "e".repeat(64)],
  });
  return Number(r.lastInsertRowid);
}

// --- (a) QUERY: getPeerMessages surfaces delivery_status ---

test("getPeerMessages includes delivery_status per message (sent + received)", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const contactId = await mkContact(db, { crowId: "crow:render-test", name: "Render Test" });
    await db.execute({
      sql: `INSERT INTO messages (contact_id, content, direction, delivery_status) VALUES (?,?,?,?)`,
      args: [contactId, "will fail", "sent", "failed"],
    });
    await db.execute({
      sql: `INSERT INTO messages (contact_id, content, direction, delivery_status) VALUES (?,?,?,?)`,
      args: [contactId, "went out", "sent", "relayed"],
    });
    await db.execute({
      sql: `INSERT INTO messages (contact_id, content, direction, delivery_status) VALUES (?,?,?,?)`,
      args: [contactId, "hi there", "received", null],
    });

    const msgs = await getPeerMessages(db, contactId);
    assert.equal(msgs.length, 3);
    const byContent = Object.fromEntries(msgs.map((m) => [m.content, m.delivery_status]));
    assert.equal(byContent["will fail"], "failed");
    assert.equal(byContent["went out"], "relayed");
    assert.equal(byContent["hi there"], null);
  } finally {
    cleanup();
  }
});

test("getPeerMessages afterId variant returns ascending new rows incl. delivery_status", async () => {
  const calls = [];
  const db = {
    execute: async (query) => {
      calls.push(query);
      return {
        rows: [
          { id: 11, content: "first", direction: "received", delivery_status: null, attachments: null },
          { id: 12, content: "second", direction: "sent", delivery_status: "relayed", attachments: null },
        ],
      };
    },
  };

  const msgs = await getPeerMessages(db, 42, { afterId: 10, limit: 50 });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE m\.contact_id = \? AND m\.id > \?/);
  assert.match(calls[0].sql, /ORDER BY m\.id ASC/);
  assert.match(calls[0].sql, /m\.delivery_status/);
  assert.match(calls[0].sql, /c\.last_seen/);
  assert.deepEqual(calls[0].args, [42, 10, 50]);

  // NOT reversed for afterId — rows come back in the same (ascending) order.
  assert.deepEqual(msgs.map((m) => m.id), [11, 12]);
});

// --- (b) RENDER: appendBubble surfaces delivery_status on reload ---

// Grab a named `function name(...) { ... }` declaration out of the generated
// script text via balanced-brace matching (no eval of the whole file).
function extractFunction(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in generated client script`);
  const braceStart = src.indexOf("{", start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return src.slice(start, i);
}

// Minimal hand-rolled DOM stub — just enough surface for el()/appendBubble()/
// markBubbleFailed(): createElement, createTextNode, appendChild, textContent,
// className, classList.add/contains, dataset, style.cssText, setAttribute,
// addEventListener (no-op), querySelector (recursive class search).
function makeFakeDocument() {
  function makeElement(tag) {
    const node = {
      tagName: tag,
      _text: "",
      children: [],
      attributes: {},
      style: { cssText: "" },
      className: "",
      dataset: {},
      classList: {
        _set: new Set(),
        add(c) {
          this._set.add(c);
        },
        contains(c) {
          return this._set.has(c);
        },
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      setAttribute(k, v) {
        this.attributes[k] = v;
      },
      addEventListener() {},
      querySelector(sel) {
        const cls = sel.replace(".", "");
        const search = (n) => {
          for (const c of n.children || []) {
            if (c.className && String(c.className).split(/\s+/).includes(cls)) return c;
            const found = search(c);
            if (found) return found;
          }
          return null;
        };
        return search(this);
      },
    };
    Object.defineProperty(node, "textContent", {
      get() {
        return this._text;
      },
      set(v) {
        this._text = v;
        this.children = [];
      },
    });
    return node;
  }
  return {
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
  };
}

function buildAppendBubble(lang = "en") {
  const script = messagesClientJS({ aiConfigured: false, storageAvailable: false, lang });
  const elSrc = extractFunction(script, "el");
  const relativeTimeSrc = extractFunction(script, "relativeTime");
  const appendBubbleSrc = extractFunction(script, "appendBubble");
  const markBubbleFailedSrc = extractFunction(script, "markBubbleFailed");

  const context = {
    document: makeFakeDocument(),
    _activeItem: { type: "peer" },
    _messages: [],
    console,
  };
  vm.createContext(context);
  vm.runInContext(
    `${elSrc}\n${relativeTimeSrc}\n${appendBubbleSrc}\n${markBubbleFailedSrc}\nglobalThis.__appendBubble = appendBubble;`,
    context,
  );
  return context.__appendBubble;
}

function renderBubble(msg, lang) {
  const appendBubble = buildAppendBubble(lang);
  const container = {
    children: [],
    appendChild(n) {
      this.children.push(n);
      return n;
    },
  };
  return appendBubble(container, msg);
}

test("sent message with delivery_status='failed' renders the failed indicator on reload", () => {
  const bubble = renderBubble({ direction: "sent", content: "hi", delivery_status: "failed" });
  assert.ok(bubble.classList.contains("msg-bubble-failed"), "bubble should carry msg-bubble-failed class");
  const note = bubble.querySelector(".msg-bubble-failed-note");
  assert.ok(note, "a failed note should be present");
  assert.match(note.textContent, /not delivered/i);
});

test("sent message with delivery_status='relayed' renders a single check", () => {
  const bubble = renderBubble({ direction: "sent", content: "hi", delivery_status: "relayed" });
  assert.equal(bubble.classList.contains("msg-bubble-failed"), false);
  const indicator = bubble.querySelector(".msg-delivery");
  assert.ok(indicator, "a relayed check indicator should be present");
  assert.equal(indicator.textContent, "✓");
});

test("sent message with delivery_status='delivered' renders a double check", () => {
  const bubble = renderBubble({ direction: "sent", content: "hi", delivery_status: "delivered" });
  const indicator = bubble.querySelector(".msg-delivery");
  assert.ok(indicator, "a delivered double-check indicator should be present");
  assert.equal(indicator.textContent, "✓✓");
});

test("sent message with delivery_status=null/pending renders no indicator", () => {
  for (const status of [null, undefined, "pending"]) {
    const bubble = renderBubble({ direction: "sent", content: "hi", delivery_status: status });
    assert.equal(bubble.classList.contains("msg-bubble-failed"), false, `status=${status}`);
    assert.equal(bubble.querySelector(".msg-delivery"), null, `status=${status}`);
    assert.equal(bubble.querySelector(".msg-bubble-failed-note"), null, `status=${status}`);
  }
});

test("received message never renders a delivery indicator regardless of delivery_status", () => {
  const bubble = renderBubble({ direction: "received", content: "hi", delivery_status: "failed" });
  assert.equal(bubble.classList.contains("msg-bubble-failed"), false);
  assert.equal(bubble.querySelector(".msg-delivery"), null);
  assert.equal(bubble.querySelector(".msg-bubble-failed-note"), null);
});

test("Spanish lang renders the same symbols (i18n only touches tooltip text)", () => {
  const relayed = renderBubble({ direction: "sent", content: "hola", delivery_status: "relayed" }, "es");
  assert.equal(relayed.querySelector(".msg-delivery").textContent, "✓");
  const failed = renderBubble({ direction: "sent", content: "hola", delivery_status: "failed" }, "es");
  assert.ok(failed.querySelector(".msg-bubble-failed-note"));
});
