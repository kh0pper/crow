/**
 * The Models page change sheet (roles Phase 2, PR 2a Task 7): the client JS
 * that opens the sheet, lists picks, renders the who-moves / cloud warning
 * and saves with the acks the preview asked for.
 *
 * The client is evaluated with `new Function` against a tiny fake DOM and a
 * stubbed fetch. Assertions read substrings, counts and single nodes, never a
 * whole document.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelsClientJS } from "../servers/gateway/dashboard/settings/sections/models/client.js";
import { renderModelsPage } from "../servers/gateway/dashboard/settings/sections/models.js";

// --- a tiny DOM ---------------------------------------------------------------

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this._text = "";
    this.className = "";
    this.disabled = false;
    this.checked = false;
    this.hidden = false;
    this.type = "";
    this.open = false;
    this.parentNode = null;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, extra = {}) {
    for (const fn of this.listeners[type] || []) fn({ type, target: this, currentTarget: this, preventDefault() {}, ...extra });
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function walk(node, out = []) {
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
}
const findAll = (root, pred) => walk(root).filter(pred);
const byAttr = (root, name, value) => findAll(root, (n) => n.hasAttribute(name) && (value === undefined || n.getAttribute(name) === value));

function makeDoc(buttons) {
  const dialog = new El("dialog");
  dialog.setAttribute("id", "models-change");
  const body = new El("body");
  body.appendChild(dialog);
  for (const b of buttons) body.appendChild(b);
  const docListeners = {};
  return {
    dialog,
    body,
    cookie: "crow_lang=en; crow_csrf=tok%2D1",
    createElement: (t) => new El(t),
    getElementById: (id) => (id === "models-change" ? dialog : null),
    // T5: only the Change buttons are bound (the selector is scoped).
    querySelectorAll: (sel) => (sel === ".mr-change[data-role]" ? buttons : []),
    addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); },
    docListeners,
  };
}

function roleButton(id, kind = "chat", label = "Scout") {
  const b = new El("button");
  b.className = "mr-change";
  b.setAttribute("data-role", id);
  b.setAttribute("data-role-kind", kind);
  b.setAttribute("data-role-label", label);
  return b;
}

const json = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null) },
  json: async () => data,
  text: async () => JSON.stringify(data),
});
const plain = (status, text) => ({
  ok: false,
  status,
  headers: { get: (n) => (n.toLowerCase() === "content-type" ? "text/plain; charset=utf-8" : null) },
  json: async () => { throw new SyntaxError("Unexpected token"); },
  text: async () => text,
});

/** routes: [{match:(url, init)=>bool, reply:(url, init)=>Response}] (first match wins) */
function harness(routes, { kind = "chat", role = "quick", label = "Scout" } = {}) {
  const btn = roleButton(role, kind, label);
  const doc = makeDoc([btn]);
  const calls = [];
  const visits = [];
  const fetchStub = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const r = routes.find((x) => x.match(url, init));
    if (!r) throw new Error("no stub for " + url);
    return r.reply(url, init);
  };
  const win = { Turbo: { visit: (href, opts) => visits.push({ href, opts }) } };
  const loc = { href: "https://crow.example.ts.net/dashboard/settings?section=models", reload() { visits.push({ reload: true }); } };
  const src = modelsClientJS({ lang: "en" });
  new Function("document", "fetch", "window", "location", src)(doc, fetchStub, win, loc);
  return { btn, doc, calls, visits };
}

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

const PICKS = {
  picks: [
    { key: "local-chat/m1", label: "m1 <img src=x>", where: "here", provider: "local-chat", recommended: true, allowed: true },
    { key: "cloud-a/c1", label: "c1", where: "cloud", provider: "cloud-a", recommended: false, allowed: true },
  ],
};
const PREVIEW = (over = {}) => ({
  roleId: "quick",
  current: { key: null, where: "missing" },
  next: { key: "local-chat/m1", reason: "bound", chain: [], where: "here" },
  consumers: {
    unattended: [{ kind: "bot", id: "b1", label: "Night bot", field: "model", via: ["quick"] }],
    bots: [{ kind: "bot", id: "b2", label: "Day bot", field: "model", via: ["quick"] }],
    subagents: [],
    jobs: [{ kind: "job", id: "smart-router:fast", label: "Smart router (fast)", labelKey: "settings.providers.job.smart.fast", field: "default", via: ["quick"] }],
    otherCrows: [],
    notAffected: [{ kind: "job", id: "llm-router:fast", label: "Voice router (fast)", labelKey: "settings.providers.job.voiceFast", field: "env:COMPANION_FAST_MODEL", via: ["quick"] }],
    keepsOwnModel: [{ kind: "bot", id: "b3", label: "Own bot", field: "model", via: [] }],
  },
  cloud: null,
  refused: [],
  reembed: false,
  pin: null,
  envPinned: false,
  needs: { ackUnattended: true, ackCloud: false },
  previewHash: "hash-1",
  ...over,
});

const isPicks = (u) => u === "/api/roles/quick/picks";
const isPreview = (u) => u === "/api/roles/quick/preview";
const isApply = (u) => u === "/api/roles/quick";

async function openAndChoose(h, key = "local-chat/m1") {
  h.btn.fire("click");
  await flush();
  const pick = byAttr(h.doc.dialog, "data-mc-pick", key)[0];
  assert.ok(pick, "pick " + key + " listed");
  pick.fire("click");
  await flush();
  return pick;
}

// --- static ------------------------------------------------------------------

test("the client source: no backtick, no innerHTML, the API it needs", () => {
  for (const lang of ["en", "es"]) {
    const src = modelsClientJS({ lang });
    assert.equal(src.includes("`"), false, "no backtick (" + lang + ")");
    assert.equal(src.includes("innerHTML"), false, "textContent only");
    for (const s of ["X-Crow-Csrf", "/api/roles/", "previewHash", "ackUnattended", "ackCloud", "replacePin"]) {
      assert.ok(src.includes(s), "contains " + s);
    }
  }
  assert.ok(modelsClientJS({ lang: "es" }).includes("Esto cambia el modelo para:"));
});

test("the page carries the sheet and the client, and one data-role per Change button", () => {
  const rows = [{ id: "quick", group: "thinking", labelKey: "settings.roles.quick", jobKey: "settings.roleJobs.quick", kind: "chat", status: { code: "not_set" } }];
  const html = renderModelsPage(rows, { lang: "en" });
  assert.equal(html.split('id="models-change"').length - 1, 1);
  assert.equal(html.split('data-role="').length - 1, 1);
  assert.ok(html.includes('data-role-kind="chat"'));
  assert.ok(html.includes('data-role-label="Scout"'));
  assert.ok(html.includes("<script>") && html.includes("X-Crow-Csrf"));
});

// --- behaviour ---------------------------------------------------------------

test("Change registers a click on [data-role] and lists picks as text, with Not set", async () => {
  const h = harness([{ match: isPicks, reply: () => json(200, PICKS) }]);
  assert.equal((h.btn.listeners.click || []).length, 1, "one click listener");
  h.btn.fire("click");
  await flush();
  assert.equal(h.doc.dialog.open, true);
  assert.equal(h.calls[0].url, "/api/roles/quick/picks");
  const picks = byAttr(h.doc.dialog, "data-mc-pick");
  assert.equal(picks.length, 3, "Not set + two picks");
  assert.ok(picks[0].textContent.includes("Not set"));
  assert.ok(h.doc.dialog.textContent.includes("m1 <img src=x>"), "label as text");
  assert.equal(findAll(h.doc.dialog, (n) => n.tagName === "IMG").length, 0);
  assert.ok(picks[1].textContent.includes("★"), "recommended star");
  assert.ok(picks[1].textContent.includes("This box"));
  assert.ok(h.doc.dialog.textContent.includes("Scout"), "title is the role label");
});

test("a refused pick is disabled with the refusal", async () => {
  const h = harness([{ match: (u) => u === "/api/roles/safety/picks", reply: () => json(200, {
    picks: [{ key: "cloud-a/c1", label: "c1", where: "cloud", provider: "cloud-a", recommended: false, allowed: false, why: "cloud_refused" }],
  }) }], { role: "safety", label: "Classifier" });
  h.btn.fire("click");
  await flush();
  const p = byAttr(h.doc.dialog, "data-mc-pick", "cloud-a/c1")[0];
  assert.equal(p.disabled, true);
  assert.ok(p.textContent.includes("Classifier refuses models that aren't proven local"));
});

test("ackUnattended keeps Save disabled until ticked; Save posts the hash and acks, then reloads", async () => {
  const h = harness([
    { match: isPicks, reply: () => json(200, PICKS) },
    { match: isPreview, reply: () => json(200, PREVIEW()) },
    { match: isApply, reply: () => json(200, { ok: true, preview: PREVIEW() }) },
  ]);
  await openAndChoose(h);
  assert.deepEqual(h.calls[1].body, { model: "local-chat/m1" });
  assert.equal(h.calls[1].init.headers["X-Crow-Csrf"], "tok-1");
  const text = h.doc.dialog.textContent;
  assert.ok(text.includes("This changes the model for:"));
  const iU = text.indexOf("Unattended"), iB = text.indexOf("Bots"), iJ = text.indexOf("Crow jobs");
  assert.ok(iU > -1 && iU < iB && iB < iJ, "groups in order");
  assert.equal(text.includes("Sub-agents"), false, "empty group omitted");
  assert.equal(text.includes("Other Crows"), false, "empty group omitted");
  assert.ok(text.includes("Night bot") && text.includes("Smart router (fast)"));
  assert.ok(text.includes("Not affected (set by environment)") && text.includes("Voice router (fast)"));
  assert.ok(text.includes("Name their model directly and keep it: Own bot"));

  const save = byAttr(h.doc.dialog, "data-mc-save")[0];
  const box = byAttr(h.doc.dialog, "data-mc-ack", "unattended")[0];
  assert.ok(box, "ack checkbox");
  assert.ok(text.includes("These run on their own. I understand they will switch too."));
  assert.equal(save.disabled, true);
  save.fire("click");
  await flush();
  assert.equal(h.calls.length, 2, "a disabled Save sends nothing");
  box.checked = true;
  box.fire("change", { target: box });
  assert.equal(save.disabled, false);
  assert.equal(save.textContent, "Save");
  save.fire("click");
  await flush();
  const apply = h.calls[2];
  assert.equal(apply.url, "/api/roles/quick");
  assert.deepEqual(apply.body, { model: "local-chat/m1", previewHash: "hash-1", ackUnattended: true, ackCloud: false, replacePin: false });
  assert.deepEqual(h.visits, [{ href: "https://crow.example.ts.net/dashboard/settings?section=models", opts: { action: "replace" } }]);
});

test("a cloud change: the sentence names the host, the fallback note, and Save reads Use … for all of these", async () => {
  const h = harness([
    { match: isPicks, reply: () => json(200, PICKS) },
    { match: isPreview, reply: () => json(200, PREVIEW({
      needs: { ackUnattended: false, ackCloud: true },
      cloud: { host: "api.example.com", viaRole: "quick", model: "cloud-a/c1", now: false },
      paired: true,
    })) },
    { match: isApply, reply: () => json(200, { ok: true }) },
  ]);
  await openAndChoose(h, "cloud-a/c1");
  const text = h.doc.dialog.textContent;
  assert.ok(text.includes("Messages, files and tool results these send will go to api.example.com. Crow has no other gate for this."));
  assert.ok(text.includes("(if c1 is unavailable)"));
  assert.ok(text.includes("This also changes it on your paired Crows."));
  const save = byAttr(h.doc.dialog, "data-mc-save")[0];
  assert.equal(save.disabled, false);
  assert.equal(save.textContent, "Use c1 for all of these");
  save.fire("click");
  await flush();
  assert.equal(h.calls[2].body.ackCloud, true);
});

test("a cloud host of null falls back to the provider, never 'null'", async () => {
  const h = harness([
    { match: isPicks, reply: () => json(200, PICKS) },
    { match: isPreview, reply: () => json(200, PREVIEW({
      needs: { ackUnattended: false, ackCloud: true },
      cloud: { host: null, viaRole: "quick", model: "cloud-a/c1", now: true },
    })) },
  ]);
  await openAndChoose(h, "cloud-a/c1");
  const text = h.doc.dialog.textContent;
  assert.ok(text.includes("will go to cloud-a."));
  assert.equal(text.includes("null"), false);
  assert.equal(text.includes("unavailable"), false, "now:true has no fallback note");
});

test("pin, re-embed and refusals", async () => {
  const h = harness([
    { match: (u) => u === "/api/roles/embed/picks", reply: () => json(200, { picks: [{ key: "local-chat/e1", label: "e1", where: "here", provider: "local-chat", recommended: false, allowed: true }] }) },
    { match: (u) => u === "/api/roles/embed/preview", reply: () => json(200, PREVIEW({
      roleId: "embed",
      needs: { ackUnattended: false, ackCloud: false },
      pin: { setting: "embed_provider", value: "old-embed" },
      reembed: true,
      refused: [{ id: "phone_local_model", labelKey: "settings.providers.phone.local" }],
    })) },
    { match: (u) => u === "/api/roles/embed", reply: () => json(200, { ok: true }) },
  ], { role: "embed", label: "Embeddings" });
  h.btn.fire("click");
  await flush();
  byAttr(h.doc.dialog, "data-mc-pick", "local-chat/e1")[0].fire("click");
  await flush();
  const text = h.doc.dialog.textContent;
  assert.ok(text.includes("Replace the pin (old-embed)"));
  assert.ok(text.includes("Phone calls (local model) refuses models that aren't proven local"));
  const re = findAll(h.doc.dialog, (n) => n._text.startsWith("Memories saved before this change"))[0];
  assert.ok(re, "re-embed line present");
  assert.equal(re.hidden, true, "hidden while the pin stays");
  const pin = byAttr(h.doc.dialog, "data-mc-pin")[0];
  pin.checked = true;
  pin.fire("change", { target: pin });
  assert.equal(re.hidden, false);
  byAttr(h.doc.dialog, "data-mc-save")[0].fire("click");
  await flush();
  assert.equal(h.calls[2].body.replacePin, true);
});

test("409 preview_changed re-renders the returned preview under the changed notice", async () => {
  let n = 0;
  const h = harness([
    { match: isPicks, reply: () => json(200, PICKS) },
    { match: isPreview, reply: () => json(200, PREVIEW({ needs: { ackUnattended: false, ackCloud: false } })) },
    { match: isApply, reply: () => { n++; return json(409, { ok: false, reason: "preview_changed", preview: PREVIEW({ previewHash: "hash-2", needs: { ackUnattended: true, ackCloud: false } }) }); } },
  ]);
  await openAndChoose(h);
  byAttr(h.doc.dialog, "data-mc-save")[0].fire("click");
  await flush();
  assert.equal(n, 1);
  const text = h.doc.dialog.textContent;
  assert.ok(text.includes("Something changed since you looked. Check the list again."));
  assert.equal(h.visits.length, 0);
  const save = byAttr(h.doc.dialog, "data-mc-save")[0];
  assert.equal(save.disabled, true, "the new preview needs the unattended ack");
  const box = byAttr(h.doc.dialog, "data-mc-ack", "unattended")[0];
  box.checked = true;
  box.fire("change", { target: box });
  save.fire("click");
  await flush();
  assert.equal(h.calls[h.calls.length - 1].body.previewHash, "hash-2");
});

test("a plain-text 403 (CSRF refusal) shows a generic error and never throws", async () => {
  const h = harness([
    { match: isPicks, reply: () => json(200, PICKS) },
    { match: isPreview, reply: () => plain(403, "Forbidden: bad CSRF token") },
  ]);
  await openAndChoose(h);
  const err = byAttr(h.doc.dialog, "data-mc-error")[0];
  assert.ok(err.textContent.includes("reload"), "generic try again / reload");
  assert.equal(h.doc.dialog.textContent.includes("Forbidden"), false, "server text not shown");
  assert.equal(byAttr(h.doc.dialog, "data-mc-save")[0].disabled, true);
});

test("speech: profiles listed, cloud warning falls back to the provider name for an azure profile with no endpoint", async () => {
  const h = harness([
    { match: (u) => u === "/api/roles/stt/picks", reply: () => json(200, { picks: [], profiles: [
      { id: "az", name: "Azure speech", provider: "azure", isDefault: false, where: "cloud", host: null },
      { id: "w1", name: "Whisper here", provider: "whispercpp", isDefault: true, where: "here", host: "127.0.0.1" },
    ] }) },
    { match: (u) => u === "/api/roles/stt/profile/preview", reply: () => json(200, { where: "cloud", host: null, cloud: true, paired: true, previewHash: "sp-1" }) },
    { match: (u) => u === "/api/roles/stt/profile", reply: () => json(200, { ok: true }) },
  ], { role: "stt", kind: "speech", label: "Speech to text" });
  h.btn.fire("click");
  await flush();
  const picks = byAttr(h.doc.dialog, "data-mc-pick");
  assert.equal(picks.length, 2, "profiles only, no Not set");
  picks.find((p) => p.getAttribute("data-mc-pick") === "az").fire("click");
  await flush();
  assert.deepEqual(h.calls[1].body, { profileId: "az" });
  const text = h.doc.dialog.textContent;
  assert.ok(text.includes("What you say (or what Crow says) will be sent to azure."));
  assert.equal(text.includes("null"), false);
  assert.ok(text.includes("This also changes it on your paired Crows."));
  const save = byAttr(h.doc.dialog, "data-mc-save")[0];
  assert.equal(save.textContent, "Use Azure speech for all of these");
  save.fire("click");
  await flush();
  assert.deepEqual(h.calls[2].body, { profileId: "az", previewHash: "sp-1", ackCloud: true });
  assert.equal(h.visits.length, 1);
});

test("a media role lists nothing to pick", async () => {
  const h = harness([{ match: (u) => u === "/api/roles/image/picks", reply: () => json(200, { picks: [] }) }], { role: "image", kind: "media", label: "Image generation" });
  h.btn.fire("click");
  await flush();
  assert.equal(byAttr(h.doc.dialog, "data-mc-pick").length, 0);
  assert.ok(h.doc.dialog.textContent.includes("Not set up yet"));
});

// --- final fix wave ------------------------------------------------------------

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test("T6: the warning area is a polite live region", async () => {
  const h = harness([{ match: isPicks, reply: () => json(200, PICKS) }]);
  const warn = byAttr(h.doc.dialog, "data-mc-warn")[0];
  assert.equal(warn.getAttribute("aria-live"), "polite");
});

test("T7: Save waits for THE ack box: ticking the pin box does not enable it, unticking the ack disables it again", async () => {
  const h = harness([
    { match: isPicks, reply: () => json(200, PICKS) },
    { match: isPreview, reply: () => json(200, PREVIEW({ pin: { setting: "embed_provider", value: "old" } })) },
  ]);
  await openAndChoose(h);
  const save = byAttr(h.doc.dialog, "data-mc-save")[0];
  const pin = byAttr(h.doc.dialog, "data-mc-pin")[0];
  const ack = byAttr(h.doc.dialog, "data-mc-ack", "unattended")[0];
  assert.equal(save.disabled, true);
  pin.checked = true;
  pin.fire("change", { target: pin });
  assert.equal(save.disabled, true, "another checkbox never enables Save");
  ack.checked = true;
  ack.fire("change", { target: ack });
  assert.equal(save.disabled, false);
  ack.checked = false;
  ack.fire("change", { target: ack });
  assert.equal(save.disabled, true, "unticked again");
});

test("T7: a network failure on Save shows the generic error, re-enables Save and never reloads", async () => {
  const h = harness([
    { match: isPicks, reply: () => json(200, PICKS) },
    { match: isPreview, reply: () => json(200, PREVIEW({ needs: { ackUnattended: false, ackCloud: false } })) },
    { match: isApply, reply: () => { throw new TypeError("Failed to fetch"); } },
  ]);
  await openAndChoose(h);
  const save = byAttr(h.doc.dialog, "data-mc-save")[0];
  save.fire("click");
  await flush();
  assert.ok(byAttr(h.doc.dialog, "data-mc-error")[0].textContent.includes("reload"));
  assert.equal(h.doc.dialog.textContent.includes("Failed to fetch"), false);
  assert.equal(save.disabled, false);
  assert.equal(h.visits.length, 0);
  assert.equal(h.doc.dialog.open, true);
});

test("T7: a double click on Save sends one POST", async () => {
  const d = deferred();
  const h = harness([
    { match: isPicks, reply: () => json(200, PICKS) },
    { match: isPreview, reply: () => json(200, PREVIEW({ needs: { ackUnattended: false, ackCloud: false } })) },
    { match: isApply, reply: () => d.promise },
  ]);
  await openAndChoose(h);
  const save = byAttr(h.doc.dialog, "data-mc-save")[0];
  save.fire("click");
  save.fire("click");
  await flush();
  assert.equal(h.calls.filter((c) => c.url === "/api/roles/quick").length, 1);
  d.resolve(json(200, { ok: true }));
  await flush();
  assert.equal(h.visits.length, 1);
});

test("T1: the picks are disabled while a Save is in flight, and come back as they were", async () => {
  const d = deferred();
  const h = harness([
    { match: isPicks, reply: () => json(200, { picks: [...PICKS.picks, { key: "cloud-b/c9", label: "c9", where: "cloud", provider: "cloud-b", recommended: false, allowed: false, why: "cloud_refused" }] }) },
    { match: isPreview, reply: () => json(200, PREVIEW({ needs: { ackUnattended: false, ackCloud: false } })) },
    { match: isApply, reply: () => d.promise },
  ]);
  await openAndChoose(h);
  byAttr(h.doc.dialog, "data-mc-save")[0].fire("click");
  await flush();
  const picks = byAttr(h.doc.dialog, "data-mc-pick");
  assert.ok(picks.every((p) => p.disabled === true), "all picks locked");
  const before = h.calls.length;
  byAttr(h.doc.dialog, "data-mc-pick", "cloud-a/c1")[0].fire("click");
  await flush();
  assert.equal(h.calls.length, before, "no preview while saving");
  d.resolve(json(500, { error: "internal" }));
  await flush();
  assert.ok(byAttr(h.doc.dialog, "data-mc-error")[0].textContent.includes("reload"));
  assert.equal(byAttr(h.doc.dialog, "data-mc-pick", "cloud-a/c1")[0].disabled, false);
  assert.equal(byAttr(h.doc.dialog, "data-mc-pick", "cloud-b/c9")[0].disabled, true, "a refused pick stays refused");
});

test("T3: clearing a role with a cloud ack reads plain Save", async () => {
  const h = harness([
    { match: isPicks, reply: () => json(200, PICKS) },
    { match: isPreview, reply: () => json(200, PREVIEW({
      needs: { ackUnattended: false, ackCloud: true },
      cloud: { host: "api.example.com", viaRole: "quick", model: "cloud-a/c1", now: true },
    })) },
  ]);
  await openAndChoose(h, "");
  const save = byAttr(h.doc.dialog, "data-mc-save")[0];
  assert.equal(save.textContent, "Save");
  assert.equal(save.textContent.includes("Not set"), false);
});

test("F6: a stored fallback chain is sent unchanged with the new model", async () => {
  const h = harness([
    { match: isPicks, reply: () => json(200, { ...PICKS, fallback: ["expert", "quick"] }) },
    { match: isPreview, reply: () => json(200, PREVIEW({ needs: { ackUnattended: false, ackCloud: false } })) },
    { match: isApply, reply: () => json(200, { ok: true }) },
  ]);
  await openAndChoose(h);
  assert.deepEqual(h.calls[1].body, { model: "local-chat/m1", fallback: ["expert", "quick"] });
  byAttr(h.doc.dialog, "data-mc-save")[0].fire("click");
  await flush();
  assert.deepEqual(h.calls[2].body.fallback, ["expert", "quick"]);
  assert.equal(h.calls[2].body.model, "local-chat/m1");
});

test("F6: no stored fallback, no fallback field", async () => {
  const h = harness([
    { match: isPicks, reply: () => json(200, PICKS) },
    { match: isPreview, reply: () => json(200, PREVIEW({ needs: { ackUnattended: false, ackCloud: false } })) },
    { match: isApply, reply: () => json(200, { ok: true }) },
  ]);
  await openAndChoose(h);
  byAttr(h.doc.dialog, "data-mc-save")[0].fire("click");
  await flush();
  assert.equal("fallback" in h.calls[2].body, false);
});

test("safety never sends a stored fallback chain (the server refuses one)", async () => {
  const h = harness([
    { match: isPicks, reply: () => json(200, { ...PICKS, fallback: ["expert"] }) },
    { match: isPreview, reply: () => json(200, PREVIEW({ needs: { ackUnattended: false, ackCloud: false } })) },
    { match: isApply, reply: () => json(200, { ok: true }) },
  ], { role: "safety", label: "Safety" });
  await openAndChoose(h);
  assert.equal("fallback" in h.calls[1].body, false);
  byAttr(h.doc.dialog, "data-mc-save")[0].fire("click");
  await flush();
  assert.equal("fallback" in h.calls[2].body, false);
});

test("F9: a name is listed once per group", async () => {
  const cons = PREVIEW().consumers;
  const h = harness([
    { match: isPicks, reply: () => json(200, PICKS) },
    { match: isPreview, reply: () => json(200, PREVIEW({ consumers: { ...cons,
      bots: [cons.bots[0], { ...cons.bots[0], field: "models.escalation" }],
    } })) },
  ]);
  await openAndChoose(h);
  assert.equal(h.doc.dialog.textContent.split("Day bot").length - 1, 1);
});

test("F1: ticking Replace the pin brings in the ack the pinned job then needs", async () => {
  const h = harness([
    { match: isPicks, reply: () => json(200, PICKS) },
    { match: isPreview, reply: () => json(200, PREVIEW({
      consumers: { ...PREVIEW().consumers, unattended: [] },
      pin: { setting: "embed_provider", value: "old" },
      needs: { ackUnattended: false, ackCloud: false },
      needsIfReplacePin: { ackUnattended: true, ackCloud: false },
    })) },
    { match: isApply, reply: () => json(200, { ok: true }) },
  ]);
  await openAndChoose(h);
  const save = byAttr(h.doc.dialog, "data-mc-save")[0];
  const pin = byAttr(h.doc.dialog, "data-mc-pin")[0];
  const ack = byAttr(h.doc.dialog, "data-mc-ack", "unattended")[0];
  assert.equal(save.disabled, false, "the pin stays: nothing moves");
  assert.equal(ack.parentNode.hidden, true, "the ack is not asked yet");
  pin.checked = true;
  pin.fire("change", { target: pin });
  assert.equal(ack.parentNode.hidden, false);
  assert.equal(save.disabled, true);
  ack.checked = true;
  ack.fire("change", { target: ack });
  assert.equal(save.disabled, false);
  pin.checked = false;
  pin.fire("change", { target: pin });
  assert.equal(ack.parentNode.hidden, true);
  save.fire("click");
  await flush();
  assert.equal(h.calls[2].body.replacePin, false);
  assert.equal(h.calls[2].body.ackUnattended, false, "a hidden ack is never sent");
});

test("F4: a pin with nothing safe to show reads custom setting", async () => {
  const h = harness([
    { match: (u) => u === "/api/roles/safety/picks", reply: () => json(200, PICKS) },
    { match: (u) => u === "/api/roles/safety/preview", reply: () => json(200, PREVIEW({
      roleId: "safety", needs: { ackUnattended: false, ackCloud: false },
      pin: { setting: "bot_safety_classifier", value: null, custom: true },
    })) },
  ], { role: "safety", label: "Classifier" });
  await openAndChoose(h);
  const text = h.doc.dialog.textContent;
  assert.ok(text.includes("Replace the pin (custom setting)"));
  assert.equal(text.includes("null"), false);
});
