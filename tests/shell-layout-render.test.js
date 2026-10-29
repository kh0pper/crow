/**
 * The shell variant of renderLayout (redesign P2, Task 2.2): string-level
 * render checks, like tests/perch-hub-render.test.js's static half.
 *
 * Classic mode must stay byte-identical to what main rendered before the
 * shell existed, apart from the one crow-mode meta line. The snapshot in
 * tests/fixtures/shell/classic-layout-snapshot.html was captured from main's
 * renderLayout before layout.js was edited, using the options in
 * tests/fixtures/shell/classic-layout-opts.mjs.
 *
 * THIS IS A DELIBERATE TRIPWIRE. Any change to classic layout output (CSS,
 * markup, scripts) fails the "classic output is unchanged" test on purpose, so
 * it cannot slip in unnoticed. A PR that means to change classic must
 * regenerate the snapshot in the same PR and justify the diff in its
 * description:
 *
 *   UPDATE_CLASSIC_SNAPSHOT=1 node scripts/run-suite.mjs tests/shell-layout-render.test.js
 *
 * which rewrites tests/fixtures/shell/classic-layout-snapshot.html from the
 * current output (minus the two intended shell-only differences handled
 * below). Review `git diff` of the fixture before committing it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { renderLayout } from "../servers/gateway/dashboard/shared/layout.js";
import { shellCss } from "../servers/gateway/dashboard/shell/css.js";
import { shellClientJs } from "../servers/gateway/dashboard/shell/client.js";
import { perchHubCss, PERCH_SPLIT_MIN_WIDTH } from "../servers/gateway/dashboard/perch-hub/css.js";
import { CLASSIC_OPTS } from "./fixtures/shell/classic-layout-opts.mjs";

// The snapshot was taken with Turbo on (the default).
delete process.env.CROW_ENABLE_TURBO;

const SNAPSHOT_URL = new URL("./fixtures/shell/classic-layout-snapshot.html", import.meta.url);
let SNAPSHOT = readFileSync(SNAPSHOT_URL, "utf8");

const ALL_PANELS = new Set([
  "board", "make", "messages", "bot-builder", "schedule", "memory", "media",
  "ramble", "extensions", "model-catalog", "artifacts",
]);
const stubPanels = (ids) => (id) => (ids.has(id) ? { id } : undefined);

const PROJECTS = [
  { id: 3, slug: "garden", name: "Garden" },
  { id: 7, slug: "kitchen", name: "Kitchen" },
];

const BIRD = '<button id="crow-tama" class="tama-btn" aria-label="Crow">BIRD-SVG</button>';
const PLAYER = '<div id="crow-player-bar" data-turbo-permanent>PLAYER</div>';

function shellOpts(over = {}) {
  const { shell: shellOver, ...rest } = over;
  return {
    title: "Board",
    content: '<div id="page-body">hello</div>',
    activePanel: "bot-board",
    panels: [{ id: "bot-board", name: "Bot board", icon: "bot", route: "/dashboard/bot-board", navOrder: 1 }],
    scripts: "window.__pageScript = 1;",
    afterContent: PLAYER,
    headerIcons: BIRD,
    lang: "en",
    variant: "shell",
    shell: {
      scope: { all: true },
      projects: PROJECTS,
      tab: "board",
      getPanel: stubPanels(ALL_PANELS),
      ...(shellOver || {}),
    },
    ...rest,
  };
}

const MODE_META_RE = /\n[ \t]*<meta name="crow-mode"[^>]*>/;

// The one other intended byte change on classic pages: the Perch app-shell
// height subtracts --shell-tabs-h, which is unset (0px) outside body.shell.
// Undo exactly those two occurrences so everything else is compared as is.
const TABS_H = " - var(--shell-tabs-h,0px)";

test("classic output is unchanged except the mode meta", () => {
  const html = renderLayout(CLASSIC_OPTS);
  assert.equal(html.match(new RegExp(MODE_META_RE.source, "g"))?.length, 1, "exactly one crow-mode meta");
  assert.equal(html.split(TABS_H).length - 1, 2, "the only other change is the two Perch height lines");
  const stripped = html.replace(MODE_META_RE, "").split(TABS_H).join("");
  if (process.env.UPDATE_CLASSIC_SNAPSHOT === "1") {
    writeFileSync(SNAPSHOT_URL, stripped);
    SNAPSHOT = stripped;
    console.warn("[shell-layout-render] classic snapshot rewritten; review the fixture diff and justify it in the PR");
  }
  assert.equal(stripped, SNAPSHOT, "classic renderLayout drifted from main's snapshot");
});

test("classic with an explicit variant renders the same as the default", () => {
  assert.equal(renderLayout({ ...CLASSIC_OPTS, variant: "classic" }), renderLayout(CLASSIC_OPTS));
});

test("the shell keeps the classic chain", () => {
  const html = renderLayout(shellOpts());
  const order = ['class="main-content"', 'class="content-header', 'id="crow-instance-tabs"', 'class="content-body"'];
  let at = -1;
  for (const needle of order) {
    const i = html.indexOf(needle);
    assert.ok(i > at, `${needle} missing or out of order`);
    at = i;
  }
  assert.ok(html.includes('id="crow-toasts"'), "toasts container kept");
  assert.ok(html.includes("window.crowToast"), "toast helper kept");
  assert.ok(html.includes(PLAYER), "afterContent (player bar) kept");
  assert.ok(html.includes("window.__pageScript = 1;"), "page scripts kept");
  assert.ok(html.includes('<div id="page-body">hello</div>'), "content kept");
  assert.ok(!html.includes('class="sidebar"'), "no classic sidebar");
  assert.ok(!html.includes('id="sidebar-reveal-btn"'), "no hamburger");
  assert.ok(!html.includes("function toggleSidebar"), "no sidebar scripts");
  assert.ok(/<body class="shell[ "]/.test(html), "body carries the shell class");
});

test("the shell body keeps the page's own body class", () => {
  const html = renderLayout(shellOpts());
  assert.match(html, /<body class="shell unified-off">/);
});

test("the shell nav sits after </main>", () => {
  const html = renderLayout(shellOpts());
  const mainEnd = html.indexOf("</main>");
  const nav = html.indexOf('<nav class="shell-tabs"');
  assert.ok(mainEnd > 0 && nav > mainEnd, "tabs come after </main>");
});

function tabAnchors(html) {
  const nav = html.match(/<nav class="shell-tabs"[\s\S]*?<\/nav>/);
  assert.ok(nav, "shell-tabs nav rendered");
  return [...nav[0].matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((a) => /class="shell-tab"/.test(a));
}

test("three tabs with the active one marked", () => {
  const anchors = tabAnchors(renderLayout(shellOpts()));
  assert.equal(anchors.length, 3);
  const current = anchors.filter((a) => a.includes('aria-current="page"'));
  assert.equal(current.length, 1);
  assert.ok(current[0].includes('href="/dashboard/board"'));
  assert.ok(anchors.some((a) => a.includes('href="/dashboard/perch"')));
  assert.ok(anchors.some((a) => a.includes('href="/dashboard/make"')));
});

test("a drawer page marks no tab", () => {
  const anchors = tabAnchors(renderLayout(shellOpts({ shell: { tab: null } })));
  assert.equal(anchors.filter((a) => a.includes("aria-current")).length, 0);
});

test("without a board panel the Board tab falls back to the bot board", () => {
  const ids = new Set(ALL_PANELS);
  ids.delete("board");
  const anchors = tabAnchors(renderLayout(shellOpts({ shell: { getPanel: stubPanels(ids) } })));
  assert.ok(anchors.some((a) => a.includes('href="/dashboard/bot-board"') && a.includes('aria-current="page"')));
  assert.ok(!anchors.some((a) => a.includes('href="/dashboard/board"')));
});

test("without a make panel the Make tab falls back to artifacts", () => {
  const ids = new Set(ALL_PANELS);
  ids.delete("make");
  const anchors = tabAnchors(renderLayout(shellOpts({ shell: { tab: "make", getPanel: stubPanels(ids) } })));
  assert.ok(anchors.some((a) => a.includes('href="/dashboard/artifacts"') && a.includes('aria-current="page"')));
  assert.ok(!anchors.some((a) => a.includes('href="/dashboard/make"')));
});

test("with neither make nor artifacts registered the Make tab goes to Extensions", () => {
  const ids = new Set(ALL_PANELS);
  ids.delete("make");
  ids.delete("artifacts");
  const anchors = tabAnchors(renderLayout(shellOpts({ shell: { tab: "make", getPanel: stubPanels(ids) } })));
  assert.ok(anchors.some((a) => a.includes('href="/dashboard/extensions?q=artifacts"') && a.includes('aria-current="page"')));
  assert.ok(!anchors.some((a) => /href="\/dashboard\/(make|artifacts)"/.test(a)));
});

test("both sheets have a 44px close button with a label", () => {
  const html = renderLayout(shellOpts({ lang: "es" }));
  for (const id of ["shell-drawer", "shell-avatar"]) {
    const dlg = html.match(new RegExp('<dialog id="' + id + '"[\\s\\S]*?<\\/dialog>'))[0];
    const btn = dlg.match(/<button[^>]*class="shell-sheet-close"[^>]*>/);
    assert.ok(btn, id + " has a close button");
    assert.ok(btn[0].includes('aria-label="Cerrar"'), btn[0]);
  }
  assert.match(shellCss(), /body\.shell \.shell-sheet-close\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/);
  const js = shellClientJs();
  assert.ok(js.includes(".shell-sheet-close"), "the close button is wired");
  assert.ok(js.includes("removeAttribute('open')"), "the no-showModal fallback can be dismissed");
});

test("the avatar button says what the sheet holds", () => {
  const en = renderLayout(shellOpts()).match(/<button[^>]*class="shell-avatar"[^>]*>/)[0];
  assert.ok(en.includes('aria-label="Settings and mode"'), en);
  const es = renderLayout(shellOpts({ lang: "es" })).match(/<button[^>]*class="shell-avatar"[^>]*>/)[0];
  assert.ok(es.includes('aria-label="Ajustes y modo"'), es);
});

test("open sheets are closed before Turbo caches the page", () => {
  const js = shellClientJs();
  assert.ok(js.includes("turbo:before-cache"));
  assert.match(js, /if \(!window\.__crowShellCacheBound\) \{\s*window\.__crowShellCacheBound = true;\s*document\.addEventListener\('turbo:before-cache'/);
  assert.ok(js.includes("dialog.shell-sheet[open]"));
  // Run it: a fake document with one open sheet gets it closed, once.
  const listeners = {};
  const closed = [];
  const sheet = { close() { closed.push("close"); } };
  const fakeDoc = {
    cookie: "",
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === "dialog.shell-sheet[open]" ? [sheet] : []),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  };
  const fakeWin = {};
  const run = new Function("document", "window", "location", js);
  run(fakeDoc, fakeWin, { pathname: "/", search: "" });
  run(fakeDoc, fakeWin, { pathname: "/", search: "" });
  assert.equal(listeners["turbo:before-cache"].length, 1, "bound once per document");
  listeners["turbo:before-cache"][0]();
  assert.deepEqual(closed, ["close"]);
});

function chipText(html) {
  const m = html.match(/<button[^>]*class="shell-scope"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(m, "scope chip rendered");
  assert.ok(m[0].includes('aria-haspopup="dialog"'));
  return m[1].replace(/<[^>]*>/g, "").trim();
}

test("the project chip names the scope", () => {
  assert.equal(chipText(renderLayout(shellOpts())), "Everything");
  assert.equal(chipText(renderLayout(shellOpts({ lang: "es" }))), "Todo");
  assert.equal(chipText(renderLayout(shellOpts({ shell: { scope: { unassigned: true } } }))), "Unassigned");
  assert.equal(chipText(renderLayout(shellOpts({ lang: "es", shell: { scope: { unassigned: true } } }))), "Sin asignar");
  assert.equal(chipText(renderLayout(shellOpts({ shell: { scope: { projectId: 7 } } }))), "Kitchen");
  assert.equal(chipText(renderLayout(shellOpts({ lang: "es", shell: { scope: { projectId: 3 } } }))), "Garden");
});

test("the chip sits inside the content header, and project names are escaped", () => {
  const html = renderLayout(shellOpts({
    shell: { scope: { projectId: 9 }, projects: [{ id: 9, slug: "x", name: "<b>Evil</b>" }] },
  }));
  const header = html.match(/<header class="content-header[^"]*">[\s\S]*?<\/header>/)[0];
  assert.ok(header.includes('class="shell-scope"'));
  assert.ok(header.includes('class="shell-avatar"'));
  assert.ok(!html.includes("<b>Evil</b>"));
  assert.ok(html.includes("&lt;b&gt;Evil&lt;/b&gt;"));
});

test("the drawer lists the projects in one scope form", () => {
  const html = renderLayout(shellOpts({ shell: { scope: { projectId: 7 } } }));
  const drawer = html.match(/<dialog id="shell-drawer"[\s\S]*?<\/dialog>/);
  assert.ok(drawer, "drawer dialog rendered");
  const forms = [...drawer[0].matchAll(/<form\b[^>]*action="\/dashboard\/scope"[^>]*>/g)];
  assert.ok(forms.length >= 1 && forms.every((f) => /method="post"/i.test(f[0])));
  for (const v of ["all", "unassigned"]) {
    assert.ok(drawer[0].includes(`name="scope" value="${v}"`), `scope button ${v}`);
  }
  // Projects are links to their homes (the scope still follows the cookie).
  for (const v of ["garden", "kitchen"]) {
    assert.ok(drawer[0].includes(`href="/dashboard/project/${v}"`), `home link ${v}`);
  }
});

test("the drawer lists only registered panels", () => {
  const without = new Set(ALL_PANELS);
  without.delete("schedule");
  const a = renderLayout(shellOpts({ shell: { getPanel: stubPanels(without) } }));
  assert.ok(!a.includes('href="/dashboard/schedule"'));
  const b = renderLayout(shellOpts());
  assert.ok(b.includes('href="/dashboard/schedule"'));
  for (const href of ["/dashboard/messages", "/dashboard/bot-builder", "/dashboard/memory", "/dashboard/media",
    "/dashboard/ramble", "/dashboard/extensions", "/dashboard/model-catalog"]) {
    assert.ok(b.includes(`href="${href}"`), `${href} in the grid`);
  }
  const none = renderLayout(shellOpts({ shell: { getPanel: stubPanels(new Set()) } }));
  assert.ok(!none.includes('href="/dashboard/messages"'));
});

test("the avatar sheet offers settings, reach and the classic switch", () => {
  const html = renderLayout(shellOpts());
  const sheet = html.match(/<dialog id="shell-avatar"[\s\S]*?<\/dialog>/);
  assert.ok(sheet, "avatar dialog rendered");
  assert.ok(sheet[0].includes('href="/dashboard/settings"'));
  assert.ok(sheet[0].includes('href="/dashboard/settings?section=integrations"'));
  const form = sheet[0].match(/<form\b[^>]*action="\/dashboard\/mode"[^>]*>/);
  assert.ok(form && /method="post"/i.test(form[0]), "a POST form to /dashboard/mode");
  assert.ok(sheet[0].includes('name="mode" value="classic"'));
  assert.ok(sheet[0].includes("Use classic Crow"));
});

test("the mode meta forces a reload", () => {
  const shell = renderLayout(shellOpts());
  assert.ok(shell.includes('<meta name="crow-mode" content="shell" data-turbo-track="reload">'));
  const classic = renderLayout(CLASSIC_OPTS);
  assert.ok(classic.includes('<meta name="crow-mode" content="classic" data-turbo-track="reload">'));
  const head = shell.slice(0, shell.indexOf("</head>"));
  assert.ok(head.includes(shellCss()), "the shell CSS is in the head");
  assert.ok(!classic.includes("body.shell"), "classic ships no shell CSS");
});

/** Every selector in a CSS string, with the enclosing at-rule prelude (or ""). */
function selectorsOf(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const stack = [];
  let buf = "";
  for (const ch of src) {
    if (ch === "{") {
      const prelude = buf.trim();
      buf = "";
      if (prelude.startsWith("@")) {
        stack.push({ at: prelude });
      } else {
        for (const sel of prelude.split(",")) out.push({ sel: sel.trim(), at: stack.map((s) => s.at).join(" ") });
        stack.push({ rule: true });
      }
    } else if (ch === "}") {
      stack.pop();
      buf = "";
    } else if (ch === ";" && stack.length && stack[stack.length - 1].rule) {
      buf = "";
    } else {
      buf += ch;
    }
  }
  return out;
}

test("every shell rule is scoped", () => {
  const css = shellCss().replace(/^<style[^>]*>|<\/style>$/g, "");
  const sels = selectorsOf(css);
  assert.ok(sels.length > 10, "parsed the shell CSS");
  const bad = sels.filter((s) => !s.sel.startsWith("body.shell"));
  assert.deepEqual(bad, [], "every shell selector starts with body.shell");
  assert.ok(sels.some((s) => s.at.includes("min-width: 1024px")), "a desktop rail block exists");
});

test("the tab bar publishes its height and is a rail on desktop", () => {
  const css = shellCss();
  assert.match(css, /--shell-tabs-h:\s*calc\(56px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  const desk = css.slice(css.indexOf("@media (min-width: 1024px)"));
  assert.match(desk, /--shell-tabs-h:\s*0px/);
  assert.match(css, /body\.shell \.content-body\s*\{[^}]*padding-bottom:\s*var\(--shell-tabs-h,0px\)/);
  assert.match(css, /min-height:\s*44px/);
});

test("the Perch height subtracts the tab bar", () => {
  const html = renderLayout(CLASSIC_OPTS);
  const rule = html.match(/body:has\(#perch-chat\) \.main-content \{([^}]*)\}/);
  assert.ok(rule);
  const heights = rule[1].match(/height: calc\([^;]*\);/g).filter((h) => !/min-height/.test(h));
  assert.equal(heights.length, 2);
  assert.ok(heights.every((h) => h.includes("- var(--shell-tabs-h,0px)")), heights.join(" | "));
  assert.ok(heights[0].includes("100vh") && heights[1].includes("100dvh"));
});

test("the phone chat view keeps the tab bar, stepping it aside only for an on-screen keyboard", () => {
  const css = perchHubCss();
  const start = css.indexOf(`@media (max-width:${PERCH_SPLIT_MIN_WIDTH - 1}px){`);
  assert.ok(start >= 0, "phone media block present");
  // The block's own extent: walk braces from its opening.
  let depth = 0, end = -1;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) { end = i; break; }
  }
  const block = css.slice(start, end);
  // Phone review 2026-10-29: Chat · Board · Make stays in an open chat.
  assert.ok(!block.includes('body.shell[data-view="chat"] .shell-tabs{display:none}'));
  assert.ok(!block.includes('body.shell[data-view="chat"]{--shell-tabs-h:0px}'));
  assert.ok(block.includes('body.shell[data-view="chat"][data-perch-kb] .shell-tabs{display:none}'));
  assert.ok(block.includes('body.shell[data-view="chat"][data-perch-kb]{--shell-tabs-h:0px}'));
});

test("the bird header survives", () => {
  const html = renderLayout(shellOpts());
  const header = html.match(/<header class="content-header[^"]*">[\s\S]*?<\/header>/)[0];
  assert.ok(header.includes(BIRD), "headerIcons verbatim inside .content-header");
  assert.ok(html.includes('id="crow-talk-overlay"'), "Talk to Crow overlay kept");
  assert.ok(html.includes("window.openCrowTalk"), "Talk to Crow JS kept");
});

test("the shell client JS has no backticks and wires the dialogs", () => {
  const js = shellClientJs();
  assert.ok(!js.includes("`"), "client JS embedded in a template literal must not contain backticks");
  assert.ok(js.includes("showModal"));
  const html = renderLayout(shellOpts());
  assert.ok(html.includes(js), "client JS is emitted on shell pages");
  assert.ok(!renderLayout(CLASSIC_OPTS).includes(js), "and not on classic pages");
});

// Phone review 2026-10-29: with the mascot's tray (dashboard/index.js passes
// shell.tray in new mode), the mascot opens ONE "Notifications and settings"
// sheet and there is no separate avatar button.
test("with the mascot's tray: one Notifications and settings sheet, tray first, and no avatar button (en, es)", async () => {
  const { tamagotchiHtml, tamagotchiTrayHtml } = await import("../servers/gateway/dashboard/shared/notifications.js");
  for (const lang of ["en", "es"]) {
    const html = renderLayout(shellOpts({ lang, headerIcons: tamagotchiHtml(lang, { sheet: true }), shell: { tray: tamagotchiTrayHtml(lang) } }));
    const header = html.match(/<header class="content-header[^"]*">[\s\S]*?<\/header>/)[0];
    assert.ok(!html.includes('class="shell-avatar"'), "no avatar button");
    assert.ok(!header.includes('id="crow-dropdown"'), "the tray is not in the header");
    const bird = header.match(/<button[^>]*id="crow-bird-btn"[^>]*>/)[0];
    const name = lang === "es" ? "Notificaciones y ajustes" : "Notifications and settings";
    assert.ok(bird.includes(`aria-label="${name}"`), bird);
    assert.ok(bird.includes('aria-haspopup="dialog"') && bird.includes('aria-controls="shell-avatar"') && bird.includes('data-shell-tray="crow-dropdown"'));
    const sheet = html.match(/<dialog id="shell-avatar"[\s\S]*?<\/dialog>/)[0];
    assert.ok(sheet.includes(`aria-label="${name}"`));
    const list = sheet.indexOf('id="notif-list"'), settings = sheet.indexOf('href="/dashboard/settings"');
    assert.ok(list > 0 && settings > list, "the notifications come first, then the settings links");
    assert.ok(sheet.includes('href="/dashboard/settings?section=integrations"') && sheet.includes('name="mode" value="classic"'));
    assert.equal((html.match(/id="notif-list"/g) || []).length, 1, "one notifications list on the page");
  }
});

test("classic and tray-less renders keep their tray in the header and the avatar fallback", async () => {
  const { tamagotchiHtml } = await import("../servers/gateway/dashboard/shared/notifications.js");
  const classic = tamagotchiHtml("en");
  assert.ok(classic.includes('id="crow-dropdown"') && classic.includes('aria-controls="crow-dropdown"') && !classic.includes("data-shell-tray"));
  assert.ok(renderLayout(shellOpts()).includes('class="shell-avatar"'), "no tray handed in: the avatar button stays the way to settings");
});

test("phones: the title leaves the header row (own line, or screen-reader only on a tab page), and the chip name can shrink", () => {
  const css = shellCss();
  const m = css.match(/@media \(max-width: 1023px\) \{[\s\S]*?\n  \}/);
  assert.ok(m, "the phone header block");
  assert.match(m[0], /body\.shell \.content-header \{ flex-wrap: wrap;/);
  assert.match(m[0], /body\.shell \.content-header h2 \{[^}]*order: 10;[^}]*flex: 1 0 100%;/);
  assert.match(m[0], /body\.shell \.content-header\.shell-header--tab h2 \{[^}]*clip-path: inset\(50%\)/);
  assert.match(css, /body\.shell \.shell-scope-name \{ min-width: 0;/);
  assert.ok(renderLayout(shellOpts({ shell: { tab: "board" } })).includes('<header class="content-header shell-header--tab">'));
  assert.ok(renderLayout(shellOpts({ shell: { tab: null } })).includes('<header class="content-header">'));
});
