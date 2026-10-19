/**
 * "By voice on displays: …" — what a bot can DO by voice on a display (the kiosk, the phone & dashboard
 * Talk to Crow), from its real tools. Pure: no I/O. The runner's abilitiesOf() wires it (turn.js).
 *
 * One source of truth: the voice turn's own classification (tool-families.js classifyTools), asked
 * with a fixed request per ability (its probe, en and es). There is no second list of "fast" tools.
 * The rule (review 2026-10-19, Kevin's answers): the line may UNDERSTATE, never overstate.
 *  - quick:   the turn would offer a tool backing the ability to the quick model;
 *  - slower:  only when the turn would escalate (classifyTools' actionWithheld, the display not
 *             backing the request) AND escalation is on AND the larger model's key resolves;
 *  - else the ability is left out (the turn would answer "not ready" or the quick model could not do it).
 * A probe is read in both languages; the weaker answer wins.
 * A tool backs an ability only when it CHANGES something (action-claims toolEffect "write"): a read-only
 * calendar would get the claim gate's "not done" line, so it is never advertised.
 */
import { toolEffect, toolNameWords } from "./action-claims.js";

/**
 * The #499 action objects (bundles/kiosk/server/action-intent.js ACTION_OBJECTS), each an ability with a
 * canonical request. `core`: the one core category that backs it (any write action in its manifest);
 * `tokens`: object words an add-on tool's name must carry (right after its write verb, or before it as
 * its namespace: "ws_cal_create_event", "todo_add_item", "send_email"). `verbs`: when set, the write verb
 * must be one of them (creating a message group is not sending a message).
 */
export const ABILITIES = Object.freeze([
  { id: "calendar", object: "calendar", probe: { en: "add lunch on Monday to my calendar", es: "añade una comida el lunes a mi calendario" },
    tokens: ["cal", "calendar", "calendars", "gcal", "event", "events", "appointment", "appointments"] },
  { id: "reminders", object: "reminders", probe: { en: "set a reminder to call alex at five", es: "pon un recordatorio para llamar a alex a las cinco" },
    tokens: ["remind", "reminder", "reminders", "alarm", "alarms"] },
  { id: "messages", object: "messages", probe: { en: "send an email to alex saying I am running late", es: "envía un correo a alex diciendo que llego tarde" },
    tokens: ["mail", "email", "emails", "gmail", "message", "messages", "sms"], verbs: ["send", "reply"] },
  // Crow's own messages (core sharing: Nostr contacts), never email or SMS.
  { id: "crow_messages", object: "messages", core: "sharing", probe: { en: "send a message to alex saying I am running late", es: "envía un mensaje a alex diciendo que llego tarde" },
    tokens: ["message", "messages"], verbs: ["send", "reply"] },
  { id: "lists", object: "lists", probe: { en: "add milk to my shopping list", es: "añade leche a mi lista de la compra" },
    tokens: ["todo", "todos", "task", "tasks", "shopping", "grocery", "list", "lists"] },
].map((a) => Object.freeze({ ...a, probe: Object.freeze(a.probe), tokens: Object.freeze(a.tokens) })));

/** Words shown after the four (core families with a phrase list); they never decide anything. */
export const SECONDARY = Object.freeze([
  Object.freeze({ id: "projects", family: "core:projects" }),
  Object.freeze({ id: "blog", family: "core:blog" }),
  Object.freeze({ id: "news", family: "core:media" }),
  Object.freeze({ id: "files", family: "core:storage" }),
]);

/** Does this (effective) tool name back one of the add-on abilities? → the ability, or null. */
export function backsAbility(name, list = ABILITIES.filter((a) => !a.core)) {
  if (toolEffect(name) !== "write") return null;
  const parts = toolNameWords(name).split("_");
  const verb = parts.findIndex((w) => toolEffect(w) !== "unknown");
  if (verb < 0) return null;
  const near = [...parts.slice(0, verb), parts[verb + 1]].filter(Boolean);
  return list.find((a) => (!a.verbs || a.verbs.includes(parts[verb])) && near.some((w) => a.tokens.includes(w))) || null;
}

/** Does a tool name carry any ability's object word at all (read or write)? Such an add-on is never named on its own. */
const objectWord = (name) => toolNameWords(name).split("_").some((w) => ABILITIES.some((a) => a.tokens.includes(w)));

const RANK = { none: 0, slower: 1, quick: 2 };

/**
 * tools: the turn's tools (no display tools, no memory). hidden: add-on tool names reachable only through
 * the crow_tools wrapper. classify(transcript) → classifyTools(). escalates: escalation on AND the larger
 * model's key resolves. displayBacks(transcript): a display tool would take the request (it then stays on
 * the quick model). families: createToolFamilies(). allowed(name): the bot's own policy lets it run.
 * → { items: [{ id, quick, label? }], none }
 */
export function voiceAbilities({ tools = [], hidden = [], classify, escalates = false, displayBacks = () => false, families, memoryOn = false, allowed = () => true }) {
  const probeCls = new Map();
  const cls = (t) => { if (!probeCls.has(t)) probeCls.set(t, classify(t)); return probeCls.get(t); };
  const anyCls = cls("");
  const hasWrapper = tools.some((t) => anyCls.famOf(t) === "addons");
  const items = [];
  const shownFamilies = new Set();
  for (const a of ABILITIES) {
    // { tool, family }: tool = the advertised tool that carries it (crow_tools for a hidden one).
    const backing = [];
    for (const t of tools) {
      const family = anyCls.famOf(t);
      if (family === undefined || family === "addons") continue;
      if (a.core) {
        if (family !== `core:${a.core}`) continue;
        if (families.categoryTools(family).some((n) => allowed(n) && backsAbility(n, [a]))) backing.push({ tool: t.name, family });
      } else if (!/^core:/.test(family) && allowed(t.name) && backsAbility(t.name, [a])) backing.push({ tool: t.name, family });
    }
    if (!a.core && hasWrapper) {
      for (const n of hidden) if (allowed(n) && backsAbility(n, [a])) backing.push({ tool: "crow_tools", family: families.familyOf(n) || "other" });
    }
    if (!backing.length) continue;
    let status = "quick";
    for (const lang of ["en", "es"]) {
      const probe = a.probe[lang];
      const c = cls(probe);
      const quick = backing.some((b) => c.quickTools.some((t) => t.name === b.tool) && (b.tool !== "crow_tools" || c.famWanted(b.family)));
      const s = quick ? "quick" : escalates && c.actionWithheld(true, displayBacks(probe) === true) ? "slower" : "none";
      if (RANK[s] < RANK[status]) status = s;
    }
    if (status === "none") continue;
    items.push({ id: a.id, quick: status === "quick" });
    for (const b of backing) shownFamilies.add(b.family);
  }
  const present = new Set(tools.map((t) => anyCls.famOf(t)).filter((f) => typeof f === "string"));
  // A word or a name is shown only when the bot's policy lets at least one of its tools run.
  for (const s of SECONDARY) {
    if (present.has(s.family) && families.hasList(s.family) && families.categoryTools(s.family).some((n) => allowed(n))) items.push({ id: s.id, quick: true });
  }
  // An add-on is named by its manifest name only when it has a phrase list (the quick model gets it on its
  // words) and none of its tools touches a calendar, reminder, message or list it could not be shown doing:
  // "Calendar App" on a bot that can only read the calendar would read as "adds to my calendar".
  const touchesObject = new Set(tools.filter((t) => objectWord(t.name)).map((t) => anyCls.famOf(t)));
  for (const f of present) {
    if (!f.startsWith("addon:") || shownFamilies.has(f) || touchesObject.has(f) || !families.hasList(f)) continue;
    if (!tools.some((t) => anyCls.famOf(t) === f && allowed(t.name))) continue;
    items.push({ id: f, quick: true, label: families.nameOf(f) || f.slice(6) });
  }
  if (memoryOn) items.push({ id: "memory", quick: true });
  return { items, none: items.length === 0 };
}
