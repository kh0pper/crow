/**
 * Phase 4 — the AR renderer, run exactly as the browser runs it: the file is
 * a classic script evaluated in a vm sandbox with a `window`, so the test
 * proves the dual shim AND the maths. A synthetic pose drives it: label
 * positions for known bearings, edge parking, scale by distance, the radar
 * fallback when the heading is null or the camera failed. A tiny fake
 * document smoke-tests the DOM painter (labels, taps, the bird reaction).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "../bundles/ramble/panel/static/ramble-ar.js"), "utf8");

function load(extra = {}) {
  const sandbox = { window: {}, setTimeout, clearTimeout, ...extra };
  vm.runInNewContext(SRC, sandbox);
  return { Ar: sandbox.window.RambleAr, sandbox };
}
const { Ar } = load();
/**
 * Objects and arrays built INSIDE the vm carry that realm's prototypes, and
 * assert/strict's deepEqual is deepStrictEqual (it compares prototypes), so a
 * vm-built value on the LEFT of deepEqual fails with "same structure but not
 * reference-equal". Round-trip through JSON before comparing structure.
 */
const plain = (v) => JSON.parse(JSON.stringify(v));

const HERE = { lat: 30.46, lon: -98.08 };
const NORTH_100 = { lat: 30.460898, lon: -98.08 };
const EAST_100 = { lat: 30.46, lon: -98.078958 };
const SOUTH_100 = { lat: 30.459102, lon: -98.08 };
const NORTH_500 = { lat: 30.46449, lon: -98.08 };
const anchor = (id, at, extra = {}) => ({ id, kind: "mark", lat: at.lat, lon: at.lon, accuracy_m: 10, approx_m: 0, locked: false, title: id, ...extra });
const pose = (heading) => ({ lat: HERE.lat, lon: HERE.lon, accuracy_m: 8, heading });

test("classic script: no ESM syntax, zero backticks, zero markup sinks, no emoji, no capture APIs; exports the contract", () => {
  assert.ok(!/^\s*(import|export)\s/m.test(SRC));
  assert.equal(SRC.split("`").length - 1, 0, "zero backticks");
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.deepEqual(code.match(/\.innerHTML\s*=|\bhtml:\s|insertAdjacentHTML|outerHTML/g) || [], [], "zero markup sinks");
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(SRC), "no emoji");
  assert.ok(!/toDataURL|toBlob|captureStream|ImageCapture|MediaRecorder|drawImage|getContext\(/.test(SRC), "camera frames never leave the device");
  for (const k of ["renderAr", "mountAr", "layoutAnchor", "bearingDeg", "distanceM", "relativeBearing", "compassPoint", "headingFromEvent", "smoothHeading", "noticeSeen", "markNoticeSeen"]) assert.equal(typeof Ar[k], "function", k);
  assert.deepEqual([Ar.FOV_DEG, Ar.RANGE_M, Ar.COARSE_M, Ar.PARK_MAX], [70, 500, 150, 6]);
});

test("bearing and distance for known points; relative bearing folds into [-180, 180); compass points", () => {
  assert.ok(Math.abs(Ar.distanceM(HERE, NORTH_100) - 100) < 1.5);
  assert.ok(Math.abs(Ar.distanceM(HERE, EAST_100) - 100) < 1.5);
  assert.ok(Ar.bearingDeg(HERE, NORTH_100) < 0.5 || Ar.bearingDeg(HERE, NORTH_100) > 359.5);
  assert.ok(Math.abs(Ar.bearingDeg(HERE, EAST_100) - 90) < 0.5);
  assert.ok(Math.abs(Ar.bearingDeg(HERE, SOUTH_100) - 180) < 0.5);
  assert.equal(Ar.relativeBearing(10, 350), 20);
  assert.equal(Ar.relativeBearing(350, 10), -20);
  assert.equal(Ar.relativeBearing(180, 0), -180);
  assert.equal(Ar.relativeBearing(90, 0), 90);
  assert.deepEqual([0, 45, 90, 135, 180, 225, 270, 315, 359].map(Ar.compassPoint), ["N", "NE", "E", "SE", "S", "SW", "W", "NW", "N"]);
});

test("headingFromEvent: webkitCompassHeading wins; alpha only from an absolute event, 360 - alpha + screen angle; smoothing crosses the wrap", () => {
  assert.equal(Ar.headingFromEvent({ webkitCompassHeading: 45, alpha: 200 }, 0), 45);
  assert.equal(Ar.headingFromEvent({ alpha: 90, absolute: true }, 0), 270);
  assert.equal(Ar.headingFromEvent({ alpha: 90, type: "deviceorientationabsolute" }, 90), 0);
  assert.equal(Ar.headingFromEvent({ alpha: 90, absolute: false, type: "deviceorientation" }, 0), null, "a relative alpha is not a heading");
  assert.equal(Ar.headingFromEvent({ alpha: null, absolute: true }, 0), null);
  assert.equal(Ar.headingFromEvent(null, 0), null);
  assert.equal(Ar.smoothHeading(null, 30), 30);
  assert.equal(Ar.smoothHeading(30, null), 30);
  const s = Ar.smoothHeading(359, 1, 0.5);
  assert.ok(s === 0 || s > 359.9, `359 -> 1 halfway is 0, got ${s}`);
  assert.equal(Ar.smoothHeading(0, 40, 0.25), 10);
});

test("the first-open notice gate: unseen until marked; a missing or throwing storage means the notice shows, never a crash", () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  assert.equal(Ar.noticeSeen(() => storage, "ramble.ar.limits"), false);
  assert.equal(Ar.markNoticeSeen(() => storage, "ramble.ar.limits"), true);
  assert.equal(Ar.noticeSeen(() => storage, "ramble.ar.limits"), true);
  const boom = () => { throw new Error("SecurityError"); };
  assert.equal(Ar.noticeSeen(boom, "ramble.ar.limits"), false);
  assert.equal(Ar.markNoticeSeen(boom, "ramble.ar.limits"), false);
  assert.equal(Ar.noticeSeen(() => null, "ramble.ar.limits"), false);
});

test("layout: heading 0 puts north centre-screen, east parked right, south parked left; heading 350 shifts north right of centre", () => {
  const n = Ar.layoutAnchor(anchor("n", NORTH_100), pose(0));
  assert.equal(n.visible, true); assert.equal(n.side, null);
  assert.ok(Math.abs(n.x - 0.5) < 0.01);
  const e = Ar.layoutAnchor(anchor("e", EAST_100), pose(0));
  assert.deepEqual([e.visible, e.side, e.x], [false, "right", 0.94]);
  const s = Ar.layoutAnchor(anchor("s", SOUTH_100), pose(0));
  assert.deepEqual([s.visible, s.side, s.x], [false, "left", 0.06]);
  const n2 = Ar.layoutAnchor(anchor("n", NORTH_100), pose(350));
  assert.equal(n2.visible, true);
  assert.ok(Math.abs(n2.x - (0.5 + 10 / 70)) < 0.01, `x ${n2.x}`);
  const e2 = Ar.layoutAnchor(anchor("e", EAST_100), pose(90));
  assert.equal(e2.visible, true); assert.ok(Math.abs(e2.x - 0.5) < 0.01);
});

test("layout: vertical position and scale by distance (near low and big, far high and small); sub line; locked teaser", () => {
  const near = Ar.layoutAnchor(anchor("n", NORTH_100), pose(0));
  const far = Ar.layoutAnchor(anchor("f", NORTH_500), pose(0));
  assert.ok(near.y > far.y, "nearer is lower on screen");
  assert.ok(near.scale > far.scale);
  assert.ok(Math.abs(near.y - (0.70 - 0.36 * 0.2)) < 0.01);
  assert.ok(Math.abs(near.scale - (1 - 0.5 * 0.2)) < 0.01);
  assert.ok(Math.abs(far.y - 0.34) < 0.01 && Math.abs(far.scale - 0.5) < 0.01);
  assert.equal(near.sub, "100 m");
  const locked = Ar.layoutAnchor(anchor("l", NORTH_100, { locked: true }), pose(0));
  assert.equal(locked.locked, true);
  assert.equal(locked.sub, "~100 m · locked");
  const at0 = Ar.layoutAnchor(anchor("z", HERE), pose(0));
  assert.deepEqual([at0.distance_m, at0.sub, at0.y, at0.scale], [0, "5 m", 0.70, 1]);
});

test("renderAr in ar mode: labels for in-range anchors, far first; parked overflow counted; coarse anchors get no direction; out of range dropped", () => {
  const anchors = [anchor("n", NORTH_100), anchor("e", EAST_100), anchor("s", SOUTH_100), anchor("far", { lat: 30.4681, lon: -98.08 }), anchor("caw", HERE, { kind: "caw", approx_m: 3400, title: "A caw" })];
  const f = Ar.renderAr({ anchors, pose: pose(0), bird: null });
  assert.equal(f.mode, "ar"); assert.equal(f.reason, null);
  assert.deepEqual(plain(f.visible), ["n"]);
  assert.deepEqual(plain(f.labels.map((l) => l.id).sort()), ["e", "n", "s"], "in range and not coarse");
  assert.deepEqual(plain(f.coarse), [{ id: "caw", kind: "caw", title: "A caw", sub: "somewhere in this area" }]);
  assert.deepEqual(plain(f.parked), { left: 0, right: 0 });
  assert.equal(f.radar.dots.length, 3);
  assert.equal(f.radar.list.length, 3);
  assert.equal(f.say, "n, 100 m ahead.");
  // Nine anchors to the right: six parked labels stacked by distance, three counted as overflow.
  const many = [];
  for (let i = 1; i <= 9; i++) many.push(anchor("r" + i, { lat: HERE.lat, lon: HERE.lon + 0.00025 * i }));
  const g = Ar.renderAr({ anchors: many, pose: pose(0), bird: null });
  const parked = g.labels.filter((l) => l.side === "right");
  assert.equal(parked.length, 6);
  assert.deepEqual(plain(g.parked), { left: 0, right: 3 });
  const ys = parked.slice().sort((a, b) => a.distance_m - b.distance_m).map((l) => l.y);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] > ys[i - 1], "parked labels stack down the edge by distance");
  assert.deepEqual(plain(g.labels.map((l) => l.distance_m)), plain(g.labels.map((l) => l.distance_m).slice().sort((a, b) => b - a)), "far first so near paints on top");
  assert.equal(g.say, "r1, 25 m to your right.");
});

test("renderAr radar fallback: no heading, no camera, no fix — never blank; north-up dots; the list carries distance and compass point", () => {
  const anchors = [anchor("n", NORTH_100), anchor("e", EAST_100, { locked: true })];
  const noHeading = Ar.renderAr({ anchors, pose: pose(null), bird: null });
  assert.deepEqual([noHeading.mode, noHeading.reason, noHeading.labels.length, noHeading.visible.length], ["radar", "no-heading", 0, 0]); // host-built array on the left: fine
  const dn = noHeading.radar.dots.find((d) => d.id === "n");
  assert.ok(Math.abs(dn.x - 0.5) < 0.01 && dn.y < 0.5, "north-up: the north anchor sits above centre");
  const de = noHeading.radar.dots.find((d) => d.id === "e");
  assert.ok(de.x > 0.5 && Math.abs(de.y - 0.5) < 0.01 && de.locked === true);
  assert.deepEqual(plain(noHeading.radar.list.map((r) => r.sub)), ["100 m · N", "~100 m · E · locked"]);
  assert.equal(noHeading.say, "n, 100 m N. Follow the ring.");
  const noCamera = Ar.renderAr({ anchors, pose: pose(0), bird: null, camera: false });
  assert.deepEqual([noCamera.mode, noCamera.reason, noCamera.labels.length], ["radar", "no-camera", 0]);
  const dh = noCamera.radar.dots.find((d) => d.id === "e");
  assert.ok(dh.x > 0.5, "with a heading the ring turns heading-up");
  const noFix = Ar.renderAr({ anchors, pose: { lat: null, lon: null, heading: 0 }, bird: null });
  assert.deepEqual([noFix.mode, noFix.reason, noFix.radar.dots.length, noFix.say], ["radar", "no-fix", 0, "Waiting for a fix…"]);
  const empty = Ar.renderAr({ anchors: [], pose: pose(0), bird: null });
  assert.equal(empty.say, "Nothing within 500 m. Walk a bit.");
  const onlyCoarse = Ar.renderAr({ anchors: [anchor("caw", HERE, { kind: "caw", approx_m: 3400, title: "A caw" })], pose: pose(0), bird: null });
  assert.equal(onlyCoarse.say, "Something is around here, but I can't tell which way.");
  assert.equal(onlyCoarse.coarse.length, 1);
  assert.equal(Ar.renderAr(null).mode, "radar");
});

/** The least DOM that mountAr touches: createElement/NS, textContent, attributes, style, listeners, classList, hidden, parentNode/removeChild. */
function fakeDocument() {
  const make = (tag) => {
    const el = { tag, children: [], attrs: {}, style: {}, hidden: false, listeners: {}, classes: new Set(), _text: "" };
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
    el.hasAttribute = (k) => k in el.attrs;
    el.removeAttribute = (k) => { delete el.attrs[k]; };
    el.appendChild = (c) => { el.children.push(c); c.parentNode = el; return c; };
    el.removeChild = (c) => { el.children = el.children.filter((x) => x !== c); c.parentNode = null; return c; };
    el.addEventListener = (t, fn) => { (el.listeners[t] = el.listeners[t] || []).push(fn); };
    el.click = () => { for (const fn of el.listeners.click || []) fn(); };
    el.classList = { add: (c) => el.classes.add(c), remove: (c) => el.classes.delete(c), contains: (c) => el.classes.has(c) };
    Object.defineProperty(el, "textContent", { get: () => el._text, set: (v) => { el._text = String(v); if (v === "") { el.children.forEach((c) => { c.parentNode = null; }); el.children = []; } } });
    return el;
  };
  return { createElement: make, createElementNS: (_ns, tag) => make(tag) };
}

test("mountAr paints labels with textContent, routes taps by id, mounts the bird through the engine once, and reacts when a label enters view", () => {
  const document = fakeDocument();
  const { Ar: A } = load({ document });
  const els = { root: document.createElement("div"), labels: document.createElement("div"), radar: document.createElementNS("svg", "g"), list: document.createElement("div"), coarse: document.createElement("div"), bird: document.createElementNS("svg", "svg"), egg: document.createElementNS("svg", "svg"), say: document.createElement("div"), more: document.createElement("p"), mode: document.createElement("span") };
  const mounted = [];
  const engine = { isValidBird: (b) => !!b && b.species === "crow", rollGenome: (seed, species) => ({ seed, species }), mountBird: (el, g, mood) => mounted.push([el.tag, g, mood]) };
  const taps = [];
  const session = A.mountAr(els, { engine, onTap: (id) => taps.push(id) });
  const anchors = [anchor("n", NORTH_100, { title: "near north" }), anchor("e", EAST_100, { locked: true, title: "A locked mark" })];
  const f1 = session.render({ anchors, pose: pose(90), bird: { species: "crow", seed: 7, mood: "happy" } });
  assert.equal(f1.mode, "ar");
  assert.equal(els.root.getAttribute("data-mode"), "ar");
  assert.equal(els.root.getAttribute("data-camera"), "on");
  assert.equal(els.mode.textContent, "AR");
  assert.equal(els.labels.children.length, 2);
  const east = els.labels.children.find((c) => c.getAttribute("data-id") === "e");
  assert.equal(east.getAttribute("data-locked"), "true");
  assert.equal(east.getAttribute("data-side"), null, "in view: no edge arrow");
  assert.equal(east.children[0].textContent, "A locked mark");
  assert.equal(east.children[1].textContent, "~100 m · locked");
  assert.match(east.style.left, /%$/);
  const north = els.labels.children.find((c) => c.getAttribute("data-id") === "n");
  assert.equal(north.getAttribute("data-side"), "left", "facing east, north is parked on the left edge with its arrow");
  assert.ok(Number(east.style.zIndex) > Number(north.style.zIndex), "the nearer label paints on top");
  east.click();
  assert.deepEqual(taps, ["e"]);
  assert.equal(session.anchor("e").title, "A locked mark");
  assert.equal(session.anchor("nope"), null);
  assert.deepEqual(plain(mounted), [["svg", { seed: 7, species: "crow" }, "happy"]]);
  assert.equal(els.bird.hasAttribute("hidden"), false); assert.equal(els.egg.hasAttribute("hidden"), true);
  assert.ok(els.bird.classes.has("rb-ar-react"), "east entered view on the first frame");
  assert.equal(els.radar.children.length, 2);
  assert.equal(els.say.textContent, "A locked mark, 100 m ahead.");
  // Same bird, same pose: no re-mount, no new reaction, and the SAME button
  // objects (a label rebuilt under the finger never gets its click — C3).
  els.bird.classes.delete("rb-ar-react");
  session.render({ anchors, pose: pose(90), bird: { species: "crow", seed: 7, mood: "happy" } });
  assert.equal(mounted.length, 1);
  assert.ok(!els.bird.classes.has("rb-ar-react"));
  assert.equal(els.labels.children.find((c) => c.getAttribute("data-id") === "e"), east, "the label element persists across frames");
  assert.equal(els.labels.children.length, 2);
  const rowsBefore = els.list.children;
  session.render({ anchors, pose: pose(0), bird: { species: "crow", seed: 7, mood: "happy" } });
  assert.ok(els.bird.classes.has("rb-ar-react"));
  assert.equal(els.labels.children.find((c) => c.getAttribute("data-id") === "n"), north, "still the same element after turning");
  assert.equal(north.getAttribute("data-side"), null, "now in view: the arrow is gone");
  assert.equal(east.getAttribute("data-side"), "right");
  assert.equal(els.list.children, rowsBefore, "the radar list is not rebuilt while its text is unchanged");
  // An anchor that leaves the set takes its button with it.
  session.render({ anchors: [anchors[0]], pose: pose(0), bird: { species: "crow", seed: 7, mood: "happy" } });
  assert.equal(els.labels.children.length, 1);
  assert.equal(east.parentNode, null);
  // No bird: the egg shows (given an egg to show); no heading: radar mode
  // label and rows.
  const f2 = session.render({ anchors, pose: pose(null), bird: null, hasEgg: true });
  assert.equal(f2.mode, "radar");
  assert.equal(els.mode.textContent, "Radar · no compass");
  assert.equal(els.bird.hasAttribute("hidden"), true); assert.equal(els.egg.hasAttribute("hidden"), false);
  assert.equal(els.labels.children.length, 0);
  // Neither bird nor egg: the renderer, not startAr, must hide it — it
  // repaints every frame and would otherwise undo anything startAr set.
  session.render({ anchors, pose: pose(null), bird: null, hasEgg: false });
  assert.equal(els.egg.hasAttribute("hidden"), true, "nothing to draw with no bird and no egg");
  assert.equal(els.list.children.length, 2);
  assert.notEqual(els.list.children, rowsBefore, "the mode flip repaints the list (its key includes the mode)");
  els.list.children[0].click();
  assert.deepEqual(taps, ["e", "n"]);
  // A changed title (an unlock renames a row without moving it) repaints the list.
  const renamed = anchors.map((a) => (a.id === "e" ? { ...a, title: "now read", locked: false } : a));
  const rowsNamed = els.list.children;
  session.render({ anchors: renamed, pose: pose(null), bird: null });
  assert.notEqual(els.list.children, rowsNamed);
  assert.equal(els.list.children.find((c) => c.getAttribute("data-id") === "e").children[1].children[0].textContent, "now read");
  // A coarse anchor in radar mode joins the list as a row; in AR mode it only sits in the coarse strip.
  session.render({ anchors: anchors.concat([anchor("caw", HERE, { kind: "caw", approx_m: 3400, title: "A caw" })]), pose: pose(null), bird: null });
  assert.equal(els.list.children.length, 3);
  assert.equal(els.coarse.children.length, 1);
  session.render({ anchors: anchors.concat([anchor("caw", HERE, { kind: "caw", approx_m: 3400, title: "A caw" })]), pose: pose(0), bird: null });
  assert.equal(els.list.children.length, 2);
  assert.equal(els.coarse.children.length, 1);
  session.destroy();
  assert.equal(els.labels.children.length, 0);
});

test("phase 5: reach_m marks a label near (boosted), a near nest wins the say line even when a farther mark is ahead, a near locked mark says unlock", () => {
  const nest = anchor("n1", { lat: 30.460449, lon: -98.08 }, { kind: "nest", title: "A nest", reach_m: 75, art: {} });
  const far = anchor("n2", { lat: 30.460898, lon: -98.08 }, { kind: "nest", title: "A nest", reach_m: 75 });
  const noReach = anchor("m1", { lat: 30.460449, lon: -98.08 });
  const lockedNear = anchor("l1", { lat: 30.460449, lon: -98.08 }, { locked: true, title: "A locked mark", reach_m: 75 });
  const items = [nest, far, noReach, lockedNear].map((a) => Ar.layoutAnchor(a, pose(0)));
  assert.deepEqual(items.map((i) => [i.near, i.art]), [[true, true], [false, false], [false, false], [true, false]]);
  assert.ok(items[0].scale > items[2].scale, "a near label is boosted");
  assert.equal(items[3].sub, "close enough · unlock");
  assert.equal(items[0].sub, "close enough · take it", "a near nest says so in text too (screen readers see no gold)");
  assert.equal(items[1].sub, "100 m");
  // The nest is 50 m BEHIND (heading 180 puts north behind); a mark 100 m ahead is visible. "Right here" still wins.
  const ahead = anchor("m2", { lat: 30.459102, lon: -98.08 }, { title: "ahead mark" });
  const f = Ar.renderAr({ anchors: [nest, ahead], pose: pose(180), bird: null });
  assert.deepEqual(plain(f.visible), ["m2"]);
  assert.equal(f.say, "A nest, right here — 50 m.");
  const g = Ar.renderAr({ anchors: [nest, ahead], pose: pose(null), bird: null });
  assert.equal(g.say, "A nest, right here — 50 m.", "the same line in radar mode: reach, not sight");
  assert.equal(plain(g.radar.list.map((r) => r.sub))[0], "close enough · take it", "the radar row carries the near cue for compass-less phones");
  assert.deepEqual(plain(f.labels.map((l) => [l.id, l.near])).sort(), [["m2", false], ["n1", true]]);
  assert.deepEqual([Ar.NEAR_BOOST, Ar.TAP_MS, Ar.FX_MS], [1.25, 350, 900]);
});

test("phase 5: the painter mounts art once (last child), toggles data-near, flashes a tap before onTap, and fx() reaches the label and the radar row", () => {
  const document = fakeDocument();
  const { Ar: A } = load({ document });
  const els = { root: document.createElement("div"), labels: document.createElement("div"), radar: document.createElementNS("svg", "g"), list: document.createElement("div"), coarse: document.createElement("div"), bird: document.createElementNS("svg", "svg"), egg: document.createElementNS("svg", "svg"), say: document.createElement("div"), more: document.createElement("p"), mode: document.createElement("span") };
  const art = document.createElementNS("svg", "svg");
  const taps = [];
  let tapHook = null;
  const session = A.mountAr(els, { engine: null, onTap: (id) => { if (tapHook) tapHook(id); taps.push(id); } });
  const near = anchor("n1", { lat: 30.460449, lon: -98.08 }, { kind: "nest", title: "A nest", reach_m: 75, art });
  session.render({ anchors: [near], pose: pose(0), bird: null });
  const label = els.labels.children.find((c) => c.getAttribute("data-id") === "n1");
  assert.equal(label.getAttribute("data-near"), "true");
  assert.equal(label.children.length, 3);
  assert.equal(label.children[2], art, "the art is APPENDED (CSS order puts it first) so the painter's children[0]/[1] text updates never touch it");
  assert.equal(label.children[0].textContent, "A nest");
  assert.equal(label.children[1].textContent, "close enough · take it");
  session.render({ anchors: [near], pose: pose(0), bird: null });
  assert.equal(label.children.length, 3, "mounted once, not per frame");
  assert.equal(art.textContent, "", "the art is never written to");
  // Walk away: near clears, the art stays mounted.
  session.render({ anchors: [{ ...near, lat: 30.460898 }], pose: pose(0), bird: null });
  assert.equal(label.getAttribute("data-near"), null);
  assert.equal(label.children[2], art);
  // A tap flashes BEFORE onTap runs.
  let flashedWhenTapped = false;
  tapHook = () => { flashedWhenTapped = label.classes.has("rb-ar-tapped"); };
  label.click();
  assert.equal(flashedWhenTapped, true);
  assert.deepEqual(taps, ["n1"]);
  // busy is sticky until clear; collect is timed and clears busy.
  assert.equal(session.fx("n1", "busy"), true);
  assert.ok(label.classes.has("rb-ar-fx-busy"));
  assert.equal(session.fx("n1", "clear"), true);
  assert.ok(!label.classes.has("rb-ar-fx-busy"));
  session.fx("n1", "busy");
  assert.equal(session.fx("n1", "collect"), true);
  assert.ok(label.classes.has("rb-ar-fx-collect") && !label.classes.has("rb-ar-fx-busy"));
  assert.equal(session.fx("nope", "collect"), false);
  // Radar mode: no labels, but the list row for the id takes the effect.
  session.render({ anchors: [near], pose: pose(null), bird: null });
  assert.equal(els.labels.children.length, 0);
  const row = els.list.children.find((c) => c.getAttribute("data-id") === "n1");
  assert.ok(row, "the radar row exists");
  assert.equal(session.fx("n1", "collect"), true);
  assert.ok(row.classes.has("rb-ar-fx-collect"));
  session.destroy();
});
