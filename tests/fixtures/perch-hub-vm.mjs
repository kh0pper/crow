/**
 * A vm harness for the Perch hub client (tests/secret-paste.test.js, tests/connect-card.test.js).
 *
 * The same shape as tests/perch-hub-client.test.js's full-script harness (mountHub): the WHOLE
 * emitted IIFE runs in a fresh vm context against a fake DOM, fake fetch and fake EventSource, so
 * these tests exercise the real send()/finishToolChip() wiring instead of an extracted function.
 * Copied (and trimmed to what the credential-card tasks need) from that file — a second export
 * of it would have meant editing a 6,000-line suite to reach the same helpers.
 *
 * The fake element carries what the client actually uses: children/parentNode, firstChild,
 * style, value, attributes, focus, addEventListener/_dispatch, and an .options getter that sees
 * through <optgroup>.
 */
import vm from "node:vm";

export function makeEventTarget() {
  const listeners = {};
  return {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = listeners[type]; if (!a) return;
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
    _dispatch(type, ev) { (listeners[type] || []).slice().forEach((fn) => fn(ev)); },
    _listenerCount(type) { return (listeners[type] || []).length; },
  };
}

let ID_REGISTRY = null;
let FOCUS_DOC = null;

export function makeFakeElement(tag) {
  const target = makeEventTarget();
  const attrs = {};
  const node = Object.assign(target, {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    style: Object.defineProperty({}, "setProperty", { value(k, v) { this[k] = String(v); }, enumerable: false }),
    className: "",
    textContent: "",
    value: "",
    checked: false,
    disabled: false,
    placeholder: "",
    type: "",
    files: null,
    appendChild(child) {
      this.children.push(child);
      if (child && typeof child === "object") child.parentNode = this;
      if (ID_REGISTRY && child && child.id) ID_REGISTRY[child.id] = child;
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      if (child && typeof child === "object") child.parentNode = null;
      return child;
    },
    insertBefore(node2, ref) {
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.unshift(node2); else this.children.splice(i, 0, node2);
      if (node2 && typeof node2 === "object") node2.parentNode = this;
      return node2;
    },
    setAttribute(name, val) { attrs[name] = String(val); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    removeAttribute(name) { delete attrs[name]; },
    click() { if (this.onclick) this.onclick(); },
    focus(opts) { if (FOCUS_DOC) FOCUS_DOC.activeElement = this; this._focusOpts = opts || null; },
    blur() { if (FOCUS_DOC && FOCUS_DOC.activeElement === this) FOCUS_DOC.activeElement = null; },
    contains(n) { for (let x = n; x; x = x.parentNode) { if (x === this) return true; } return false; },
  });
  Object.defineProperty(node, "firstChild", { get() { return this.children[0] || null; }, configurable: true });
  node.innerHTML = "";
  Object.defineProperty(node, "options", {
    get() { return this.children.flatMap((c) => (c && c.tagName === "OPTGROUP" ? c.children : [c])); },
    configurable: true,
  });
  return node;
}

export class FakeEventSource {
  constructor(url) {
    this.url = url;
    this._t = makeEventTarget();
    this.onopen = null;
    this.onerror = null;
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) { this._t.addEventListener(type, fn); }
  removeEventListener(type, fn) { this._t.removeEventListener(type, fn); }
  close() { this.closed = true; }
  _open() { if (this.onopen) this.onopen(); }
  _serverFrame(type, dataObj) { this._t._dispatch(type, { data: JSON.stringify(dataObj) }); }
  _nativeError() {
    const ev = {};
    this._t._dispatch("error", ev);
    if (this.onerror) this.onerror(ev);
  }
}
FakeEventSource.instances = [];

export function makeResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** A per-sessionStorage fake with the two methods the draft code uses. */
export function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

export const ROOST_ONE_LIVE = {
  birds: [{ id: "r4", name: "R4 Assistant", perch_attached: true, state: "working",
    sessions: [{ sessionId: "perchlive-aaaaaaaa", state: "awake", cardId: null, pendingUi: false, projectId: 7 }] }],
};

/** Fetch routing for a cold deep link: /roost, /options, /transcript, then 200 {}. */
export function stdFetch(overrides = {}) {
  return (method, path) => {
    for (const [matcher, fn] of Object.entries(overrides)) {
      if (path.includes(matcher)) return fn(method, path);
    }
    if (path === "/roost") return makeResponse(200, ROOST_ONE_LIVE);
    if (path.endsWith("/options")) return makeResponse(200, { models: [], thinkingLevels: [] });
    if (path.endsWith("/transcript")) return makeResponse(200, { events: [] });
    return makeResponse(200, {});
  };
}

/**
 * Mount the real emitted script in a fresh vm context.
 *   fetchImpl(method, path, opts) → response; storage: a makeStorage(); lang; project: a project
 *   row the session is filed in (drives the warning's Services link).
 */
export async function mountHub({ fetchImpl, storage, lang = "en", project = { id: 7, slug: "home", name: "Home" } } = {}) {
  const { perchHubJs } = await import("../../servers/gateway/dashboard/perch-hub/client.js");
  const js = perchHubJs(lang);

  const IDS = ["perch-list-body", "perch-transcript", "perch-ask", "perch-secret", "perch-secret-warn",
    "perch-bot-name", "perch-session-meta", "perch-session-id", "perch-state", "perch-model",
    "perch-thinking", "perch-permission", "perch-plan-mode", "perch-input", "perch-send",
    "perch-back", "perch-abort", "perch-attach", "perch-file-input", "perch-chat",
    "perch-new", "perch-new-bot", "perch-new-bot-label", "perch-launch-note", "perch-close",
    "perch-new-model", "perch-new-model-label", "perch-new-model-more", "perch-model-more",
    "perch-rename", "perch-session-name",
    "perch-new-cwd", "perch-browse-btn", "perch-cwd-note", "perch-hub-root",
    "perch-launch-more", "perch-launch-more-model",
    "perch-tab-chat", "perch-tab-session", "perch-tab-files", "perch-tab-activity",
    "perch-tab-btn-chat", "perch-tab-btn-session", "perch-tab-btn-files", "perch-tab-btn-activity",
    "perch-activity-list", "perch-session-cwd", "perch-change-cwd", "perch-working",
    "perch-files-list", "perch-files-refresh", "perch-attn", "perch-draft-note",
    "perch-fact-context", "perch-fact-uptime", "perch-fact-memory", "perch-fact-tools",
    "perch-ctxbar", "perch-ctxbar-fill", "perch-planbar", "perch-planbar-fill",
    "perch-plan-card", "perch-plan-head", "perch-plan-steps", "perch-cmdmenu",
    "perch-cwd-crumbs", "perch-cwd-list", "perch-file-viewer", "perch-fv-name",
    "perch-fv-close", "perch-fv-body", "perch-narrow-toggle", "perch-narrow-body",
    "perch-text-smaller", "perch-text-reset", "perch-text-larger", "perch-text-size-value",
    "perch-projects"];
  const els = {};
  for (const id of IDS) els[id] = makeFakeElement(id === "perch-plan-mode" ? "input" : "div");
  els["perch-projects"].textContent = JSON.stringify(project ? [project] : []);
  els["perch-input"].tagName = "TEXTAREA";

  const bodyEl = makeFakeElement("body");
  const fetchCalls = [];
  const fetchFn = fetchImpl || (() => Promise.resolve(makeResponse(200, {})));
  const dynamic = {};
  ID_REGISTRY = dynamic;

  const docTarget = makeEventTarget();
  const doc = Object.assign(docTarget, {
    cookie: "crow_csrf=test-csrf-token",
    body: bodyEl,
    documentElement: makeFakeElement("html"),
    getElementById(id) { return els[id] || dynamic[id] || null; },
    createElement(tag) { return makeFakeElement(tag); },
    createTextNode(text) { const n = makeFakeElement("#text"); n.textContent = String(text == null ? "" : text); return n; },
    activeElement: null,
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  FOCUS_DOC = doc;

  const winTarget = makeEventTarget();
  const vvTarget = makeEventTarget();
  const visualViewport = Object.assign(vvTarget, { height: 700, offsetTop: 0, scale: 1 });
  const mqTarget = makeEventTarget();
  const mq = Object.assign(mqTarget, { matches: false, media: "(min-width:900px)" });
  const win = Object.assign(winTarget, {
    visualViewport, innerHeight: 800, matchMedia: () => mq,
    sessionStorage: storage || makeStorage(),
  });
  const locState = { hash: "" };
  const location = {
    get hash() { return locState.hash; },
    set hash(v) { locState.hash = v; winTarget._dispatch("hashchange", {}); },
    replace(v) { locState.hash = String(v) === "#" ? "" : String(v); winTarget._dispatch("hashchange", {}); },
    href: "", search: "",
  };

  let timerSeq = 1;
  const timers = new Map();
  const timerDelays = new Map();
  const sandbox = {
    document: doc,
    confirm() { return false; },
    prompt() { return null; },
    window: win,
    location,
    EventSource: FakeEventSource,
    fetch(url, opts) {
      const method = (opts && opts.method) || "GET";
      const path = String(url).replace(/^.*perch-api/, "");
      fetchCalls.push({ method, path, opts });
      return Promise.resolve(fetchFn(method, path, opts));
    },
    setTimeout(fn, delay) { const id = timerSeq++; timers.set(id, fn); timerDelays.set(id, delay == null ? undefined : delay); return id; },
    clearTimeout(id) { timers.delete(id); timerDelays.delete(id); },
    setInterval(fn, delay) { const id = timerSeq++; timers.set(id, fn); timerDelays.set(id, delay == null ? undefined : delay); return id; },
    clearInterval(id) { timers.delete(id); timerDelays.delete(id); },
    FileReader: class {
      constructor() { this.onload = null; this.result = null; }
      readAsDataURL(file) {
        this.result = "data:" + (file.type || "") + ";base64," + (file.b64 || "AAAA");
        if (this.onload) this.onload();
      }
    },
  };
  vm.createContext(sandbox);
  FakeEventSource.instances.length = 0;
  vm.runInContext(js, sandbox);
  await new Promise((r) => setTimeout(r, 0));
  return { els, doc, win, location, fetchCalls, sandbox, timers, timerDelays, storage: win.sessionStorage };
}

export async function openChatSession(hub, sid = "perchlive-aaaaaaaa") {
  hub.location.hash = sid;
  await new Promise((r) => setTimeout(r, 0));
}

/** Every text node in the transcript, flattened. */
export function transcriptText(hub) {
  const deep = (n) => (n.textContent || "") + (n.children || []).map(deep).join(" ");
  return hub.els["perch-transcript"].children.map(deep).join("\n");
}

/** The first element (depth-first) whose className contains `cls`. */
export function findByClass(node, cls) {
  if (!node) return null;
  if (String(node.className || "").split(" ").includes(cls)) return node;
  for (const c of node.children || []) {
    const hit = findByClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

/** Click a button by its class inside `root`. */
export function clickClass(root, cls) {
  const node = findByClass(root, cls);
  if (!node) throw new Error("no element with class " + cls);
  if (node.onclick) node.onclick();
  return node;
}