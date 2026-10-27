/**
 * The shell variant of renderLayout (redesign P2, Task 2.2): string-level
 * render checks, like tests/perch-hub-render.test.js's static half.
 *
 * Classic mode must stay byte-identical to what main rendered before the
 * shell existed, apart from the one crow-mode meta line. The snapshot in
 * tests/fixtures/shell/classic-layout-snapshot.html was captured from main's
 * renderLayout before layout.js was edited, using the options in
 * tests/fixtures/shell/classic-layout-opts.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderLayout } from "../servers/gateway/dashboard/shared/layout.js";
import { shellCss } from "../servers/gateway/dashboard/shell/css.js";
import { shellClientJs } from "../servers/gateway/dashboard/shell/client.js";
import { perchHubCss, PERCH_SPLIT_MIN_WIDTH } from "../servers/gateway/dashboard/perch-hub/css.js";
import { CLASSIC_OPTS } from "./fixtures/shell/classic-layout-opts.mjs";

// The snapshot was taken with Turbo on (the default).
delete process.env.CROW_ENABLE_TURBO;

const SNAPSHOT = readFileSync(
  new URL("./fixtures/shell/classic-layout-snapshot.html", import.meta.url),
  "utf8",
);

const ALL_PANELS = new Set([
  "board", "make", "messages", "bot-builder", "schedule", "memory", "media",
  "ramble", "extensions", "model-catalog",
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
  assert.equal(stripped, SNAPSHOT, "classic renderLayout drifted from main's snapshot");
});

test("classic with an explicit variant renders the same as the default", () => {
  assert.equal(renderLayout({ ...CLASSIC_OPTS, variant: "classic" }), renderLayout(CLASSIC_OPTS));
});

test("the shell keeps the classic chain", () => {
  const html = renderLayout(shellOpts());
  const order = ['class="main-content"', 'class="content-header"', 'id="crow-instance-tabs"', 'class="content-body"'];
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
  return [...nav[0].matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
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
  const header = html.match(/<header class="content-header">[\s\S]*?<\/header>/)[0];
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
  for (const v of ["all", "garden", "kitchen", "unassigned"]) {
    assert.ok(drawer[0].includes(`name="scope" value="${v}"`), `scope button ${v}`);
  }
  assert.match(drawer[0], /value="kitchen"[^>]*aria-current="true"/);
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

test("the phone chat view hides the tab bar", () => {
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
  assert.ok(block.includes('body.shell[data-view="chat"] .shell-tabs{display:none}'));
  assert.ok(block.includes('body.shell[data-view="chat"]{--shell-tabs-h:0px}'));
});

test("the bird header survives", () => {
  const html = renderLayout(shellOpts());
  const header = html.match(/<header class="content-header">[\s\S]*?<\/header>/)[0];
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
