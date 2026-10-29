/**
 * Hand-off intent (PR 3, Task 3.5): the en/es phrase matchers that say whether a spoken request is bigger
 * work for a bot, a question about one, or a stop. Pure functions; no DB.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsHandoff, wantsHandoffStatus, wantsHandoffStop, namesWork, isBareStatus, mayAskStatus, namedBots, asksForHandoff, statusShape, stopShape, STATUS_LEAD_WORDS, HANDOFF_INTENT_WORDS, HANDOFF_TARGET_PHRASES } from "../servers/gateway/voice/handoff-intent.js";
import { HANDOFF_TARGET_WORDS } from "../servers/gateway/voice/handoff-constants.js";
import { normalizeIntentLists, listMatches, phraseWords, INTENT_MAX_CHARS } from "../servers/gateway/voice/tool-families.js";

const BOTS = ["Writer", "bot-hank"];
/** CPU time of one call, in ms (user + system: not fooled by a busy CI machine's wall clock). */
function cpuMs(fn) { const a = process.cpuUsage(); fn(); const d = process.cpuUsage(a); return (d.user + d.system) / 1000; }

test("wantsHandoff: research, write-ups and a named bot are hand-offs", () => {
  for (const t of [
    "research the history of community radio in Houston and write it up",
    "have writer draft a reply",
    "investiga la radio comunitaria",
    "ask hank to look into solar panels",
    "que writer escriba un informe",
    "can you write a report on bus routes",
    "haz un informe de los gastos",
    "bot hank",
    "write me a report on bus routes",
    "put together a report for the board",
    "prepare a presentation about recycling",
    "haz una investigacion sobre el reciclaje",
    "prepara un informe de ventas",
    "hazme un resumen del libro",
  ]) assert.equal(wantsHandoff(t, BOTS), true, t);
});

test("wantsHandoff: everyday requests are not", () => {
  for (const t of ["what is the weather", "add lunch to my calendar", "have a nice day", "play some jazz", "que hora es", "pon musica", ""]) {
    assert.equal(wantsHandoff(t, BOTS), false, t);
  }
  assert.equal(wantsHandoff("have writer draft a reply", []), true, "\"draft a\" is a hand-off phrase on its own");
  assert.equal(wantsHandoff("tell writer hello", []), false, "with no bots, a name is only a word");
  assert.equal(wantsHandoff("tell writer hello", BOTS), true, "a whole bot name counts");
  assert.equal(wantsHandoff("tell writers hello", BOTS), false, "only a WHOLE name");
  assert.equal(wantsHandoff(null, BOTS), false);
  assert.equal(wantsHandoff("tell writer hello", null), false, "botNames that is not an array is no names");
  assert.equal(wantsHandoff("tell writer hello", [null, 7, { name: "writer" }, ""]), false, "only strings are names");
});

test("wantsHandoffStatus: asking about a hand-off", () => {
  for (const t of ["how's it going with writer", "is it done yet", "what's the status of the research", "any news on the report", "how far along is it", "como va la investigacion", "como lo lleva", "ya termino", "ya esta listo el informe"]) {
    assert.equal(wantsHandoffStatus(t, BOTS), true, t);
  }
  assert.equal(wantsHandoffStatus("how is writer doing", BOTS), true, "how is <bot> doing");
  assert.equal(wantsHandoffStatus("is bot hank done", BOTS), true, "is <bot> done");
  assert.equal(wantsHandoffStatus("how is writer doing", []), false, "the bot check needs the bot");
  assert.equal(wantsHandoffStatus("how is my mom doing", BOTS), false, "not a bot");
  assert.equal(wantsHandoffStatus("how's writer doing", BOTS), true, "hows is a one-word lead-in");
  assert.equal(wantsHandoffStatus("how is the writer doing", BOTS), true, "an optional the before the name");
  assert.equal(wantsHandoffStatus("is the writer done", BOTS), true);
  assert.equal(wantsHandoffStatus("how's the weather doing", BOTS), false);
  // 5.3: the same forms about the work itself, with no bot named.
  for (const t of ["how's the research going", "how is the report coming", "is the report done", "is that task done", "how's the write up going"]) assert.equal(wantsHandoffStatus(t, []), true, t);
  for (const t of ["how's the game going", "is the timer done", "how's the research", "the report is done"]) assert.equal(wantsHandoffStatus(t, []), false, t);
});

test("wantsHandoffStatus: ordinary questions are not status", () => {
  for (const t of ["how's the weather", "how is it going to be tomorrow", "is it raining", "como va a estar el clima", "ya esta bien", "ya esta aqui la pizza", "ya esta lloviendo", "play some jazz", ""]) {
    assert.equal(wantsHandoffStatus(t, BOTS), false, t);
  }
  assert.equal(wantsHandoffStatus("how's it going"), true, "botNames is optional");
});

test("wantsHandoffStop: named, pronoun, or null", () => {
  assert.equal(wantsHandoffStop("stop writer", BOTS), "named");
  assert.equal(wantsHandoffStop("stop it", BOTS), "pronoun");
  assert.equal(wantsHandoffStop("stop the music", BOTS), null);
  for (const t of ["cancel the research", "please halt that task", "stop the hand off", "cancel bot hank now", "cancela la tarea", "deten a writer", "detén la investigación", "para a writer", "para la tarea por favor", "oye crow para writer"]) {
    assert.equal(wantsHandoffStop(t, BOTS), "named", t);
  }
  for (const t of ["cancel that", "stop that please", "páralo", "cancélalo ya", "detenlo", "cancela eso", "para eso", "oye crow para eso por favor"]) assert.equal(wantsHandoffStop(t, BOTS), "pronoun", t);
  for (const t of ["stop that song", "cancel it tomorrow and book friday", "stop", "what is the weather", "", null]) assert.equal(wantsHandoffStop(t, BOTS), null, String(t));
  assert.equal(wantsHandoffStop("stop writer", []), null, "a name is a bot only when it is one");
  for (const t of ["stop the handoff", "cancel that research", "cancela esa tarea", "deten esa investigacion", "para el encargo"]) assert.equal(wantsHandoffStop(t, BOTS), "named", t);
  for (const t of ["don't stop writer", "do not cancel the research", "never halt that task", "don't stop it", "i said dont cancel that"]) assert.equal(wantsHandoffStop(t, BOTS), null, t);
  assert.equal(wantsHandoffStop("no, stop writer", BOTS), "named", "a leading no is not a negation");
  assert.equal(wantsHandoffStop("don't stop writer", BOTS), null);
  // Final review I1: an article before the name, and the possessive the proposal itself speaks ("Stop Writer's task?").
  for (const t of ["stop the writer", "cancel the writer", "stop writer's task", "stop hank's research", "stop bot hanks task", "para la investigación de writer", "cancela la investigacion de bot hank"]) {
    assert.equal(wantsHandoffStop(t, ["Writer", "hank", "bot-hank"]), "named", t);
  }
  for (const t of ["para la casa", "para la investigacion de", "una nota para la writer", "don't stop the writer", "stop the music"]) {
    assert.equal(wantsHandoffStop(t, ["Writer", "hank"]), null, t);
  }
  const pair = [{ bot_id: "bot-hank", name: "hank" }, { bot_id: "w", name: "Writer" }];
  assert.deepEqual(namedBots("stop hank's research", pair, { possessive: true }), ["bot-hank"], "a stop's possessive names its bot");
  assert.deepEqual(namedBots("how are the writers doing", pair), [], "a status keeps the whole-name rule (a plural is no name)");
  for (const t of ["eso es para eso", "para eso sirve el martillo"]) assert.equal(wantsHandoffStop(t, BOTS), null, `para eso keeps the para rules: ${t}`);
});

test("wantsHandoffStop: \"para\" means stop only as the first word, with the target ending the sentence", () => {
  for (const t of [
    "escribe una nota para writer",
    "necesito un regalo para mi mama",
    "para la tarea de mañana necesito un lapiz",
    "compra pan para la investigacion de quimica",
    "esto es para writer y para hank",
    "para mi la tarea es facil",
  ]) assert.equal(wantsHandoffStop(t, BOTS), null, t);
  assert.equal(wantsHandoffStop("para la investigacion", BOTS), "named");
});

test("a bot name made only of stopwords is dropped, so it cannot make everything match", () => {
  const junk = ["the", "It", "a", "that", "the the", "la", "para", "eso"];
  for (const t of ["what is the weather", "add it to the list", "play that song", "para la tarea de mañana necesito un lapiz"]) {
    assert.equal(wantsHandoff(t, junk), false, t);
    assert.equal(wantsHandoffStatus(t, junk), false, t);
    assert.equal(wantsHandoffStop(t, junk), null, t);
  }
  assert.equal(wantsHandoffStop("stop the", junk), null);
  assert.equal(wantsHandoff("ask the writer", [...junk, "the writer"]), true, "a name with a real word still counts");
});

test("HANDOFF_TARGET_PHRASES: frozen, normalized, a superset of the correction words", () => {
  assert.ok(Object.isFrozen(HANDOFF_TARGET_PHRASES) && HANDOFF_TARGET_PHRASES.every(Object.isFrozen));
  assert.deepEqual(HANDOFF_TARGET_PHRASES, normalizeIntentLists(HANDOFF_TARGET_WORDS));
  assert.deepEqual([...HANDOFF_TARGET_WORDS.en], ["give it to", "send it to", "pass it to", "hand it to", "instead", "rather"]);
  assert.deepEqual([...HANDOFF_TARGET_WORDS.es], ["en vez", "en lugar", "mejor a", "daselo a", "pasaselo a"]);
  assert.equal(HANDOFF_TARGET_PHRASES.length, HANDOFF_TARGET_WORDS.en.length + HANDOFF_TARGET_WORDS.es.length, "no phrase dropped");
});

test("namesWork (5.3, P15): the work a hand-off produces, in both languages; things of the room are not work", () => {
  for (const t of [
    "how's the research going", "is the report done", "any news on the document", "how far along is the write up",
    "status of the task", "is that report done yet", "how is the presentation going",
    "como va la investigacion", "ya esta listo el informe", "como va el documento", "ya termino la tarea", "como lo lleva el resumen",
  ]) assert.equal(namesWork(t), true, t);
  for (const t of [
    "is the timer done", "how's the game going", "any news on the election", "ya termino la cancion", "como va el partido",
    "how's it going", "is it done", "what time is it", "", null,
  ]) assert.equal(namesWork(t), false, String(t));
});

test("isBareStatus (P16): a status phrase and filler only; a subject of its own is not bare", () => {
  for (const t of ["how's it going?", "hey crow, how's it going", "is it done yet?", "is it done already, please", "¿ya terminó?", "como va", "bueno, ¿ya está listo?", "how far along is it"]) {
    assert.equal(isBareStatus(t), true, t);
  }
  for (const t of ["how's it going with writer", "how's the research going", "any news on the election", "is the timer done", "how is it going to rain", "como va a estar el clima", "how's it going today", "como va todo", ""]) {
    assert.equal(isBareStatus(t), false, t);
  }
  assert.equal(isBareStatus("how far along is it"), true, "\"is it\" after \"how far along\" is filler-free but still bare");
});

test("STATUS_LEAD_WORDS: every status form carries one, so mayAskStatus gates the log reads (5.3)", () => {
  assert.deepEqual([...STATUS_LEAD_WORDS], ["how", "hows", "done", "status", "news", "como", "ya"]);
  for (const lang of ["en", "es"]) for (const p of HANDOFF_INTENT_WORDS.status[lang]) assert.equal(mayAskStatus(p), true, `status phrase: ${p}`);
  for (const t of ["how is writer doing", "how's the writer doing", "is bot hank done", "is the writer done"]) assert.equal(mayAskStatus(t), true, t);
  for (const t of ["play some jazz", "add lunch to my calendar", "research solar panels", "pon musica", "", null]) assert.equal(mayAskStatus(t), false, String(t));
});

test("namedBots: whole names or ids anywhere, each once, stopword-only names never", () => {
  const bots = [{ bot_id: "writer", name: "Writer" }, { bot_id: "bot-hank", name: "Hank" }, { bot_id: "the", name: "It" }];
  assert.deepEqual(namedBots("how's writer doing", bots), ["writer"]);
  assert.deepEqual(namedBots("any news on bot hank and writer", bots), ["writer", "bot-hank"], "in the order the bots were given");
  assert.deepEqual(namedBots("how's hank doing", bots), ["bot-hank"], "the display name");
  assert.deepEqual(namedBots("how are the writers doing", bots), [], "only a WHOLE name; a stopword-only name never matches");
  assert.deepEqual(namedBots("is it done", bots), [], "\"it\" is a stopword name");
  assert.deepEqual(namedBots("how's writer doing", null), []);
  assert.deepEqual(namedBots("", bots), []);
});

test("asksForHandoff: a work phrase beside the question, never the work itself", () => {
  for (const t of ["how's it going, have writer research the bus routes", "is writer done? then have helper write up the bus routes", "como va writer, y pidele a helper que investigue las rutas", "research the bus routes"]) {
    assert.equal(asksForHandoff(t), true, t);
  }
  for (const t of ["is writer done with the research", "how's writer doing on that research", "how's the research going", "is the report done", "como va la investigacion", "how's writer doing", ""]) {
    assert.equal(asksForHandoff(t), false, t);
  }
});

test("stopShape: a stop's shape about any subject; no shape, no read (5.4 fix round 1)", () => {
  for (const t of ["stop writer", "cancel the writer", "halt bot hank please", "stop the music", "oye crow, para a writer", "detén a hank ahora", "cancela el informe", "stop writer now"]) {
    assert.equal(stopShape(t), true, t);
  }
  for (const t of ["", "stop", "stop it", "don't stop writer", "never cancel that", "stop writer and start helper", "una nota para writer", "para", "stop the", "what is the capital of portugal", "stop that song right there now and play jazz"]) {
    assert.equal(stopShape(t), false, t);
  }
});

test("statusShape: the question's shape about any subject; no shape, no read", () => {
  for (const t of ["how's writer doing", "how is the writer doing", "is writer done", "is the bot hank done", "is writer done with the research", "como va writer", "ya termino writer", "como va la investigacion"]) {
    assert.equal(statusShape(t), true, t);
  }
  for (const t of ["how's it going", "is it done", "how do I get to the airport", "how's the weather", "is done", "como va a estar el clima", "ya termino", "play some jazz", ""]) {
    assert.equal(statusShape(t), false, t);
  }
});

test("isBareStatus and namesWork: the input cap holds", () => {
  const pad = "blah ".repeat(200);
  assert.equal(isBareStatus(`${pad} how's it going`), false, "past the cap is not read");
  assert.equal(namesWork(`${pad} the report`), false);
});

test("en/es parity: every list has both languages, keeps every phrase, and each phrase works in a sentence", () => {
  const lists = { target: HANDOFF_TARGET_WORDS, ...HANDOFF_INTENT_WORDS };
  for (const [name, l] of Object.entries(lists)) {
    assert.ok(Object.isFrozen(l) && Object.isFrozen(l.en) && Object.isFrozen(l.es), `${name} is frozen`);
    assert.ok(l.en.length > 0 && l.es.length > 0, `${name} has en and es`);
    assert.equal(normalizeIntentLists(l).length, l.en.length + l.es.length, `${name}: no phrase is dropped by normalization`);
  }
  // Each phrase, said in a sentence, is read by its matcher (both languages).
  const say = {
    work: (p) => assert.equal(wantsHandoff(`please ${p} the bus routes`, []), true, `work: ${p}`),
    status: (p) => assert.equal(wantsHandoffStatus(`${p} el proyecto`, []), true, `status: ${p}`),
    stopVerbs: (p) => assert.equal(wantsHandoffStop(`${p} la tarea`, []), "named", `stop verb: ${p}`),
    stopTargets: (p) => assert.equal(wantsHandoffStop(`stop ${p}`, []), "named", `stop target: ${p}`),
    stopPronouns: (p) => assert.equal(wantsHandoffStop(p, []), "pronoun", `stop pronoun: ${p}`),
    workNouns: (p) => assert.equal(namesWork(`how is ${p} going`), true, `work noun: ${p}`),
  };
  assert.deepEqual(Object.keys(say).sort(), Object.keys(HANDOFF_INTENT_WORDS).sort(), "every list is exercised");
  for (const [name, check] of Object.entries(say)) for (const lang of ["en", "es"]) for (const p of HANDOFF_INTENT_WORDS[name][lang]) check(p);
  for (const lang of ["en", "es"]) for (const p of HANDOFF_TARGET_WORDS[lang]) assert.ok(listMatches(phraseWords(`yes, ${p} writer`), HANDOFF_TARGET_PHRASES), `target: ${p}`);
});

test("the input cap: only the first INTENT_MAX_CHARS (400) are read; a 10k input is fast", () => {
  assert.equal(INTENT_MAX_CHARS, 400);
  const pad = "blah ".repeat(200);
  assert.equal(wantsHandoff(`research solar ${pad}`, BOTS), true);
  assert.equal(wantsHandoff(`${pad} research solar`, BOTS), false, "past the cap is not read");
  const big = "have ".repeat(2000) + "writer";
  const names = Array.from({ length: 500 }, (_, i) => `bot ${i} ${"x".repeat(50)}`);
  for (const fn of [() => wantsHandoff(big, names), () => wantsHandoffStatus(big, names), () => wantsHandoffStop("para ".repeat(2000), names)]) {
    const ms = cpuMs(fn);
    assert.ok(ms < 50, `${ms.toFixed(1)} ms of CPU`);
  }
});
