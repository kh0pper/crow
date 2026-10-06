import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolFamilies, phraseWords, normalizeIntentLists, listMatches, INTENT_MAX_CHARS, MAX_PHRASES } from "../servers/gateway/voice/tool-families.js";
import { TOOL_MANIFESTS } from "../servers/gateway/tool-manifests.js";
import { listInstalledExtensions, listCapabilityBundles } from "../scripts/pi-bots/ext_registry.mjs";

const cpuMs = (fn) => { const a = process.cpuUsage(); fn(); const d = process.cpuUsage(a); return (d.user + d.system) / 1000; };
const LISTED = ["projects", "blog", "sharing", "storage", "media"];
const SHIPPED_BUNDLES = ["funkwhale", "media", "kiosk"];
const bundleManifest = (id) => JSON.parse(readFileSync(new URL(`../bundles/${id}/manifest.json`, import.meta.url), "utf8"));

test("phraseWords: capped before anything else, lower case, accents and punctuation gone", () => {
  assert.deepEqual(phraseWords("¿Qué canción es ésta?"), ["que", "cancion", "es", "esta"]);
  assert.deepEqual(phraseWords("What's my  blog-post?"), ["whats", "my", "blog", "post"]);
  assert.deepEqual(phraseWords(null), []);
  assert.ok(phraseWords("a ".repeat(5000)).length <= INTENT_MAX_CHARS);
});

test("normalizeIntentLists: plain phrases only — over 4 words, over 40 characters, non-strings and entries past 40 per language are dropped", () => {
  const out = normalizeIntentLists({ en: ["Blog post", "one two three four five", "x".repeat(41), 7, "(a|b)+$", ...Array.from({ length: 60 }, (_, i) => `w${i}`)], es: ["publicación"], fr: ["nope"] });
  assert.deepEqual(out[0], ["blog", "post"]);
  assert.ok(out.some((p) => p.join(" ") === "a b"), "a pattern is only ever words");
  assert.ok(out.some((p) => p.join(" ") === "publicacion"));
  assert.ok(!out.some((p) => p.includes("nope")), "only en and es are read");
  assert.equal(out.filter((p) => /^w\d+$/.test(p[0])).length, MAX_PHRASES - 5, "the cap counts raw entries");
  assert.deepEqual(normalizeIntentLists(undefined), []);
});

test("listMatches: whole words, in order, next to each other", () => {
  const p = normalizeIntentLists({ en: ["blog post", "publish"] });
  assert.equal(listMatches(phraseWords("write a blog post about crows"), p), true);
  assert.equal(listMatches(phraseWords("post it on the blog"), p), false);
  assert.equal(listMatches(phraseWords("the publisher called"), p), false, "no substring match");
  assert.equal(listMatches(phraseWords("my blog posts"), p), false, "a plural is another word: a list names both forms");
  assert.equal(listMatches([], p), false);
});

test("families: core categories, add-on tools by connected server and by manifest, the add-on wrapper, unknown tools", () => {
  const f = createToolFamilies({
    manifests: { projects: { tools: {}, voiceIntent: { en: ["project", "projects"], es: ["proyecto", "proyectos"] } }, blog: { tools: {} } },
    connected: () => new Map([["musicbox", { status: "connected", tools: [{ name: "mb_play" }] }]]),
    listExtensions: () => [{ id: "musicbox", capabilities: { tools: [{ name: "mb_search" }], voice_intent: { en: ["music"], es: ["música"] } } }, { id: "plain", capabilities: { tools: [{ name: "pl_do" }] } }, { id: "bare", capabilities: null }],
  });
  assert.equal(f.familyOf("crow_projects"), "core:projects");
  assert.equal(f.familyOf("crow_blog"), "core:blog");
  assert.equal(f.familyOf("mb_play"), "addon:musicbox");
  assert.equal(f.familyOf("mb_search"), "addon:musicbox");
  assert.equal(f.familyOf("crow_tools"), "addons");
  assert.equal(f.familyOf("crow_delegate"), null);
  assert.deepEqual([f.hasList("core:projects"), f.hasList("core:blog"), f.hasList("addon:musicbox"), f.hasList("addon:plain")], [true, false, true, false]);
  assert.equal(f.wants("core:projects", "List my projects, please."), true);
  assert.equal(f.wants("core:projects", "¿Cuál es mi proyecto?"), true);
  assert.equal(f.wants("core:projects", "What is the capital of Portugal?"), false);
  assert.equal(f.wants("addon:musicbox", "pon música"), true);
  assert.equal(f.wants("core:blog", "write a blog post"), false, "no list, never wanted");
});

test("families: the add-on index is re-read after a minute (a newly installed add-on appears without a restart)", () => {
  let t = 0, n = 0;
  const f = createToolFamilies({ manifests: {}, now: () => t, listExtensions: () => { n += 1; return n > 1 ? [{ id: "late", capabilities: { tools: [{ name: "late_do" }] } }] : []; } });
  assert.equal(f.familyOf("late_do"), null);
  t = 30_000; assert.equal(f.familyOf("late_do"), null);
  t = 61_000; assert.equal(f.familyOf("late_do"), "addon:late");
});

test("the shipped lists: every entry survives normalisation; memory has none (its gate is the caller's)", () => {
  for (const c of LISTED) {
    const v = TOOL_MANIFESTS[c].voiceIntent;
    assert.ok(v && v.en.length >= 8 && v.es.length >= 8, c);
    assert.equal(normalizeIntentLists(v).length, v.en.length + v.es.length, `${c}: nothing dropped`);
    assert.deepEqual(Object.keys(v), ["en", "es"]);
    for (const p of [...v.en, ...v.es]) assert.match(p, /^[a-z0-9]+( [a-z0-9]+){0,3}$/, `${c}: ${p} is a plain phrase, never a pattern`);
  }
  assert.equal(TOOL_MANIFESTS.memory.voiceIntent, undefined);
  for (const id of SHIPPED_BUNDLES) {
    const v = bundleManifest(id).capabilities.voice_intent;
    assert.ok(v && v.en.length >= 6 && v.es.length >= 6, id);
    assert.equal(normalizeIntentLists(v).length, v.en.length + v.es.length, `${id}: nothing dropped`);
  }
});

// The mechanism itself: the gateway reads add-on lists through listInstalledExtensions(). Nothing is injected here.
test("the REAL loader carries voice_intent: a fixture bundle's list reaches createToolFamilies through listInstalledExtensions", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-fam-"));
  try {
    const home = join(dir, "home"), bundles = join(dir, "bundles");
    mkdirSync(join(bundles, "musicbox"), { recursive: true });
    mkdirSync(join(bundles, "plain"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(bundles, "musicbox", "manifest.json"), JSON.stringify({ id: "musicbox", name: "Music Box", capabilities: { mcp_server_id: "musicbox", tools: [{ name: "mb_play" }], voice_intent: { en: ["music", "next track", 7, "(a+)+$"], es: ["música"], fr: ["musique"] } } }));
    writeFileSync(join(bundles, "plain", "manifest.json"), JSON.stringify({ id: "plain", capabilities: { tools: [{ name: "pl_do" }] } }));
    writeFileSync(join(home, "mcp-addons.json"), JSON.stringify({ musicbox: { command: "node", args: ["x.js"] }, plain: { command: "node", args: ["y.js"] }, loose: { command: "node", args: ["z.js"] } }));
    const exts = listInstalledExtensions(home, bundles);
    assert.deepEqual(exts.map((e) => e.id), ["loose", "musicbox", "plain"]);
    assert.deepEqual(exts.find((e) => e.id === "musicbox").capabilities.voice_intent, { en: ["music", "next track", "(a+)+$"], es: ["música"] }, "strings only, en and es only");
    assert.equal("voice_intent" in exts.find((e) => e.id === "plain").capabilities, false, "absent when the manifest has none");
    const f = createToolFamilies({ manifests: {}, listExtensions: () => listInstalledExtensions(home, bundles) });
    assert.equal(f.familyOf("mb_play"), "addon:musicbox");
    assert.equal(f.hasList("addon:musicbox"), true);
    assert.equal(f.wants("addon:musicbox", "Play some music."), true);
    assert.equal(f.wants("addon:musicbox", "Pon música."), true);
    assert.equal(f.hasList("addon:plain"), false);
    assert.equal(f.familyOf("anything_else"), null, "an installed add-on with no capabilities block claims no tool");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the REAL loader on this repo's bundles: funkwhale, media and kiosk each bring a list, and every tool they declare maps to them", () => {
  const caps = new Map(listCapabilityBundles().map((b) => [b.id, b.capabilities]));
  for (const id of SHIPPED_BUNDLES) assert.ok(caps.get(id)?.voice_intent?.en?.length, `${id}: voice_intent survives the loader`);
  const dir = mkdtempSync(join(tmpdir(), "crow-fam-"));
  try {
    writeFileSync(join(dir, "mcp-addons.json"), JSON.stringify(Object.fromEntries(SHIPPED_BUNDLES.map((id) => [id, { command: "node", args: ["server/index.js"] }]))));
    const f = createToolFamilies({ manifests: TOOL_MANIFESTS, listExtensions: () => listInstalledExtensions(dir) });
    assert.equal(f.familyOf("fw_play"), "addon:funkwhale");
    assert.equal(f.hasList("addon:funkwhale"), true);
    assert.equal(f.wants("addon:funkwhale", "Play some music."), true);
    assert.equal(f.wants("addon:funkwhale", "Pon una canción de salsa."), true);
    assert.equal(f.familyOf("crow_media_feed"), "addon:media");
    assert.equal(f.familyOf("crow_media"), "core:media", "the advertised category tool is the core family");
    assert.equal(f.wants("addon:media", "What's in the news?"), true);
    assert.equal(f.wants("addon:kiosk", "Announce dinner on every display."), true);
    assert.equal(f.wants("addon:kiosk", "Put a timer on the screen."), false, "an ordinary display request does not bring the add-on's tools");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Recall: what people say for each family must hit its list, in both languages, singular and plural.
const SAID = {
  "core:projects": ["List my projects.", "What is in my project?", "Search my notes for the wifi password.", "Add a note to the garden project.", "Add this as a source.", "Make a bibliography.", "Cite that paper.", "¿Cuáles son mis proyectos?", "Busca en mis notas.", "Agrega una fuente.", "Genera la bibliografía."],
  "core:blog": ["Publish my post about crows.", "Show my drafts.", "Write a blog post.", "List my posts.", "Transpose it to G.", "What is on the setlist?", "Publica la entrada.", "Muéstrame los borradores.", "¿Qué hay en el blog?"],
  "core:sharing": ["Send a message to Alex.", "Any new messages?", "Check my inbox.", "Share this with Alex.", "Who are my contacts?", "Make an invite.", "Envía un mensaje a Alex.", "Mándale un mensaje.", "¿Tengo mensajes?", "Comparte esto con Alex.", "¿Quiénes son mis contactos?"],
  "core:storage": ["List my files.", "Upload this file.", "How much storage is left?", "Give me a download link.", "Lista mis archivos.", "Sube este archivo.", "¿Cuánto almacenamiento queda?"],
  "core:media": ["What's in the news?", "Read me the headlines.", "Any new articles?", "Subscribe to that feed.", "Give me my briefing.", "What podcasts do I follow?", "¿Qué hay en las noticias?", "Léeme los titulares.", "Dame el resumen.", "Suscríbeme a ese podcast."],
};
const PLAIN = ["What is the capital of Portugal?", "How many ounces are in a cup?", "Tell me a joke.", "What time is it?", "¿Cuál es la capital de Portugal?", "¿Cuánto es doce por doce?", "Gracias.", "Good morning.", "Show me a timer for ten minutes.", "Close that."];

test("recall: the things people say for each family hit its list, and plain questions hit none", () => {
  const f = createToolFamilies({ manifests: TOOL_MANIFESTS });
  for (const [fam, said] of Object.entries(SAID)) for (const s of said) assert.equal(f.wants(fam, s), true, `${fam} should want: ${s}`);
  for (const s of PLAIN) for (const fam of Object.keys(SAID)) assert.equal(f.wants(fam, s), false, `${fam} must not want: ${s}`);
});

// Recall against the tools themselves: the thing each tool acts on (the last word of its name) is in
// the family's list, in the singular and the plural — or is named here as deliberately left out.
const NOT_SPOKEN = new Set(["stats", "schema", "dir", "get", "capabilities", "member", "members", "log", "url", "settings", "theme", "diagram", "access", "status", "instance", "instances", "conflicts", "close", "memo", "react", "group", "groups", "discoverable", "relays", "relay", "attest", "verify", "revoke", "list", "transforms", "crosspost", "cancel", "published", "crossposts", "background", "backgrounds", "search", "action", "refresh", "listen", "playlist", "items", "folders", "preview", "song", "songs", "article"]);
// "source" belongs to projects; for the news hub people say feed, subscribe, podcast.
const NOT_SPOKEN_IN = new Set(["media:source", "media:sources"]);
test("recall against the tool names: every tool's object word is in its family's list, or is named as left out", () => {
  const f = createToolFamilies({ manifests: TOOL_MANIFESTS });
  const missing = [];
  for (const c of LISTED) for (const name of Object.keys(TOOL_MANIFESTS[c].tools)) {
    const word = name.replace(/^crow_/, "").split("_").at(-1);
    if (NOT_SPOKEN.has(word) || NOT_SPOKEN_IN.has(`${c}:${word}`)) continue;
    if (!f.wants(`core:${c}`, word)) missing.push(`${c}: ${name} (${word})`);
  }
  assert.deepEqual(missing, []);
});

test("adversarial input: 50,000-repeat transcripts answer inside 50 ms of CPU time", () => {
  const f = createToolFamilies({ manifests: TOOL_MANIFESTS });
  for (const run of ["blog ", "blog post ", "a ", "ñ", "(", "post blog "]) for (const tail of ["", " x", " publish"]) {
    const s = run.repeat(50_000) + tail;
    for (const fam of ["core:blog", "core:projects", "core:media"]) assert.ok(cpuMs(() => f.wants(fam, s)) < 50, `${fam} on ${JSON.stringify(run)}`);
  }
});
