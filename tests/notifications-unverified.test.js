/**
 * PT-3 N-5, browser side: a notification whose source ends in `_unverified`
 * (the sender is not in the user's contacts) is labelled in the list, and an
 * incoming-call toast shows a warning with the join link behind "Open link
 * anyway". The plain sources show neither. Runs the REAL generated client JS
 * (sharedNotifJs) against a tiny fake DOM; no browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedNotifJs } from "../servers/gateway/dashboard/shared/notifications.js";
import { t, translations } from "../servers/gateway/dashboard/shared/i18n.js";

const KEYS = ["notif.notContactLabel", "notif.notContactCallWarning", "notif.notContactMemoWarning", "notif.openUnverifiedLink"];

// ---------------------------------------------------------------- fake DOM
function el(tag) {
  const classes = new Set();
  const node = {
    tagName: tag.toUpperCase(), children: [], attrs: {}, textContent: "", style: {}, parentNode: null,
    className: "",
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    appendChild(ch) { ch.parentNode = node; node.children.push(ch); return ch; },
    removeChild(ch) { node.children = node.children.filter((c) => c !== ch); },
    setAttribute(k, v) { node.attrs[k] = String(v); },
  };
  return node;
}
function walk(node, out = []) { out.push(node); for (const c of node.children) walk(c, out); return out; }
const texts = (root) => walk(root).map((n) => n.textContent).filter(Boolean);
const byClass = (root, cls) => walk(root).filter((n) => String(n.className).split(" ").includes(cls));

function client(lang, { notifications = [] } = {}) {
  const body = el("body");
  const list = el("div");
  const document = {
    body, hidden: false,
    addEventListener() {},
    createElement: el,
    getElementById: (idv) => (idv === "notif-list" ? list : null),
  };
  const fetch = async () => ({ ok: true, json: async () => ({ notifications }) });
  const window = { location: {} };
  // pollNotifications lives in the page shell, not in sharedNotifJs: stubbed.
  const api = new Function("document", "fetch", "requestAnimationFrame", "setTimeout", "window", "pollNotifications",
    sharedNotifJs(lang) + "\nreturn { showCallToast, loadNotifications };",
  )(document, fetch, (fn) => fn(), () => 0, window, () => {});
  return { api, body, list, window };
}

const call = (source) => ({ id: 7, source, title: "Someone is calling", action_url: "https://call.example/r1" });
// The server stores a non-contact's link in metadata, never in action_url (I-1).
const strangerCall = () => ({ id: 8, source: "sharing:room_invite_unverified", title: "S (not in your contacts) is calling", action_url: null, metadata: { join_url: "https://call.example/r9" } });
const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------- toast
for (const lang of ["en", "es"]) {
  test(`(${lang}) the call toast for a plain room_invite shows neither the warning nor the unverified button`, () => {
    const { api, body } = client(lang);
    api.showCallToast(call("sharing:room_invite"));
    const toast = body.children[0];
    assert.ok(toast, "a toast is shown");
    assert.equal(texts(toast).includes(t("notif.notContactCallWarning", lang)), false);
    assert.equal(texts(toast).includes(t("notif.openUnverifiedLink", lang)), false);
    const accept = byClass(toast, "crow-call-toast-accept")[0];
    assert.equal(accept.textContent, "Accept");
    assert.equal(accept.href, "https://call.example/r1");
  });

  test(`(${lang}) the call toast for room_invite_unverified shows the warning and puts the link behind "Open link anyway"`, () => {
    const { api, body } = client(lang);
    api.showCallToast(call("sharing:room_invite_unverified"));
    const toast = body.children[0];
    assert.ok(texts(toast).includes(t("notif.notContactCallWarning", lang)), "warning shown");
    const accept = byClass(toast, "crow-call-toast-accept")[0];
    assert.equal(accept.textContent, t("notif.openUnverifiedLink", lang));
    assert.equal(accept.href, "https://call.example/r1", "the link is still there, behind the warning");
    assert.equal(accept.rel, "noopener noreferrer");
    // The warning comes before the actions.
    const order = toast.children.map((c) => c.className);
    assert.ok(order.indexOf("crow-call-toast-warning") < order.indexOf("crow-call-toast-actions"));
  });
}

test("an unverified call toast refuses a non-web link", () => {
  const { api, body } = client("en");
  api.showCallToast({ ...call("sharing:room_invite_unverified"), action_url: "javascript:alert(1)" });
  assert.equal(byClass(body.children[0], "crow-call-toast-accept")[0].href, "#");
});

test("(I-1) an unverified call toast reads its link from metadata, behind 'Open link anyway'", () => {
  const { api, body } = client("en");
  api.showCallToast(strangerCall());
  const accept = byClass(body.children[0], "crow-call-toast-accept")[0];
  assert.equal(accept.textContent, t("notif.openUnverifiedLink", "en"));
  assert.equal(accept.href, "https://call.example/r9");
  api.showCallToast({ ...strangerCall(), id: 9, metadata: { join_url: "javascript:alert(1)" } });
  assert.equal(byClass(body.children[1], "crow-call-toast-accept")[0].href, "#", "a non-web metadata link is refused");
});

test("(I-3) a contact's call toast follows only an http(s) link", () => {
  const { api, body } = client("en");
  api.showCallToast({ ...call("sharing:room_invite"), action_url: "javascript:alert(1)" });
  const accept = byClass(body.children[0], "crow-call-toast-accept")[0];
  assert.equal(accept.textContent, "Accept");
  assert.equal(accept.href, "#");
});

test("(I-3) clicking a plain list item follows only an http(s) or same-site link", async () => {
  for (const [url, expected] of [
    ["/dashboard/messages", "/dashboard/messages"],
    ["https://call.example/ok", "https://call.example/ok"],
    ["javascript:alert(1)", undefined],
    ["//evil.example/x", undefined],
    ["data:text/html,x", undefined],
  ]) {
    const { api, list, window } = client("en", {
      notifications: [{ id: 1, type: "peer", source: "sharing:room_invite", title: "Hal is calling", action_url: url, created_at: "2026-10-28 00:00:00" }],
    });
    await api.loadNotifications();
    list.children[0].onclick();
    await tick(); await tick();
    assert.equal(window.location.href, expected, `click on ${url}`);
  }
});

test("(I-1) the list shows an unverified call's metadata link behind 'Open link anyway'; clicking the item never navigates", async () => {
  const { api, list, window } = client("en", {
    notifications: [{ ...strangerCall(), type: "peer", created_at: "2026-10-28 00:00:00" }],
  });
  await api.loadNotifications();
  const item = list.children[0];
  const link = byClass(item, "notif-item-unverified-link")[0];
  assert.ok(link, "the labelled link is shown");
  assert.equal(link.href, "https://call.example/r9");
  item.onclick();
  await tick(); await tick();
  assert.equal(window.location.href, undefined);
});

// ---------------------------------------------------------------- list
test("the list labels _unverified items, keeps their link behind 'Open link anyway', and leaves plain items alone", async () => {
  const { api, list } = client("en", {
    notifications: [
      { id: 1, type: "peer", source: "sharing:voice_memo", title: "Voice memo from Cleo", body: "hi", created_at: "2026-10-28 00:00:00" },
      { id: 2, type: "peer", source: "sharing:voice_memo_unverified", title: "Voice memo from X (not in your contacts)", body: "hi", created_at: "2026-10-28 00:00:00" },
      { id: 3, type: "peer", source: "sharing:room_invite_unverified", title: "X (not in your contacts) is calling", action_url: "https://call.example/r", created_at: "2026-10-28 00:00:00" },
      { id: 4, type: "peer", source: "sharing:group_message_unverified", title: "[G] Someone (not in your contacts)", created_at: "2026-10-28 00:00:00" },
    ],
  });
  await api.loadNotifications();
  const [plain, memo, inv, grp] = list.children;
  assert.equal(byClass(plain, "notif-item-unverified").length, 0, "control: a plain item has no label");
  for (const item of [memo, inv, grp]) {
    assert.deepEqual(byClass(item, "notif-item-unverified").map((n) => n.textContent), [t("notif.notContactLabel", "en")]);
  }
  assert.ok(texts(memo).includes(t("notif.notContactMemoWarning", "en")));
  assert.ok(texts(inv).includes(t("notif.notContactCallWarning", "en")));
  const link = byClass(inv, "notif-item-unverified-link")[0];
  assert.equal(link.textContent, t("notif.openUnverifiedLink", "en"));
  assert.equal(link.href, "https://call.example/r");
  assert.equal(byClass(memo, "notif-item-unverified-link").length, 0, "no link without a url");
});

// ---------------------------------------------------------------- i18n
test("the N-5 keys exist in en and es with the approved copy", () => {
  for (const k of KEYS) {
    assert.ok(translations[k], `${k} exists`);
    assert.ok(translations[k].en && translations[k].es, `${k} has en and es`);
  }
  assert.equal(translations["notif.notContactLabel"].en, "Not in your contacts");
  assert.equal(translations["notif.notContactLabel"].es, "No está en tus contactos");
  assert.equal(translations["notif.openUnverifiedLink"].en, "Open link anyway");
  assert.equal(translations["notif.openUnverifiedLink"].es, "Abrir el enlace de todos modos");
  assert.equal(translations["notif.notContactCallWarning"].en, "Someone who is not in your contacts says they are calling. Open the link only if you expected this call.");
  assert.equal(translations["notif.notContactCallWarning"].es, "Alguien que no está en tus contactos dice que te está llamando. Abre el enlace solo si esperabas esta llamada.");
  assert.equal(translations["notif.notContactMemoWarning"].en, "This voice memo is from someone who is not in your contacts.");
  assert.equal(translations["notif.notContactMemoWarning"].es, "Esta nota de voz es de alguien que no está en tus contactos.");
});
