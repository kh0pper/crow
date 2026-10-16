import { test } from "node:test";
import assert from "node:assert/strict";
import { claimsAction, claimsReminder, claimText, changesSomething, CLAIM_MAX_CHARS } from "../servers/gateway/voice/action-claims.js";

test("claimsAction: a reply that says an action was done, promised or offered is a claim (en + es)", () => {
  const claims = [
    // The live reply (queue item 29), both halves.
    "I've added your car appointment for 8:15 AM on Monday to your calendar.",
    "I'll remind you about it later today.",
    "I’ve added it.",
    "I have scheduled the meeting for Tuesday.",
    "I added milk to your list.",
    "I just set a reminder for you.",
    "I'll send that email now.",
    "I will put it on your calendar.",
    "I'm going to book it for 9.",
    "I can remind you tomorrow if you like.",
    "Would you like me to add it to your calendar?",
    "Want me to set a reminder?",
    "Shall I schedule it?",
    "It's on your calendar for Monday.",
    "You're all set for Monday at 8:15.",
    "Your appointment has been added.",
    "Reminder set.",
    "Ya he añadido tu cita al calendario.",
    "He programado la cita para el lunes.",
    "Te lo recordaré esta tarde.",
    "Voy a agregar la cita.",
    "¿Quieres que te lo recuerde?",
    "Listo, la cita del lunes a las 8:15.",
    "Ya está agendada para el lunes.",
    "La cita ha sido añadida.",
    "Puedo recordarte mañana.",
    // Plan review C1: subjectless, progressive and "let me" forms.
    "Added! Your car appointment is Monday at 8:15.",
    "Let me add that to your calendar.",
    "I'm adding it now.",
    "I am adding it now.",
    "Your car appointment is scheduled for Monday at 8:15 AM.",
    "Got it — car appointment, Monday 8:15.",
    "Done.",
    "I'd be happy to remind you.",
    "Te lo recuerdo el lunes.",
    "Lo apunto en tu calendario.",
    "Hecho.",
    "Agendado para el lunes.",
  ];
  for (const s of claims) assert.equal(claimsAction(s), true, s);
});

test("claimsAction: an honest refusal or a plain answer is not a claim", () => {
  const plain = [
    "Sorry, I can't add that to your calendar from here.",
    "I can't do that from here: this assistant has no tool for it.",
    "I cannot schedule appointments on this display.",
    "I haven't added anything; I don't have a calendar tool here.",
    "Lisbon is the capital of Portugal.",
    "To add fractions, find a common denominator first.",
    "You can set a reminder in your phone's clock app.",
    "Monday is the 19th.",
    "Lo siento, no puedo añadir eso a tu calendario desde aquí.",
    "No tengo una herramienta para eso en esta pantalla.",
    "Lisboa es la capital de Portugal.",
    "",
  ];
  for (const s of plain) assert.equal(claimsAction(s), false, s);
  assert.equal(claimsAction(null), false);
  assert.equal(claimsAction(42), false);
});

test("claimText: capped before any pattern runs; long repetitive input is fast", () => {
  assert.equal(claimText("x".repeat(CLAIM_MAX_CHARS + 500)).length, CLAIM_MAX_CHARS);
  const t0 = process.cpuUsage();
  for (const unit of ["i ve ", "i ll also ", "te lo ", "he ", "it s all ", "would you like me to ", "a"]) claimsAction(unit.repeat(1000) + "?");
  const d = process.cpuUsage(t0);
  assert.ok((d.user + d.system) / 1000 < 200, "linear patterns on capped text");
});

test("claimsAction: Spanish negations are not claims", () => {
  for (const s of ["No he añadido nada.", "No te lo he puesto en el calendario.", "No voy a poder agregarlo.", "No puedo recordarte nada desde aquí.", "Todavía no está programada."]) assert.equal(claimsAction(s), false, s);
});

test("claimsReminder: a promised reminder or follow-up, which a saved memory is not", () => {
  for (const s of ["I'll remind you at 5.", "I'd be happy to remind you.", "I'll let you know tomorrow.", "Te lo recuerdo el lunes.", "Te avisaré mañana."]) assert.equal(claimsReminder(s), true, s);
  for (const s of ["I've saved that.", "Got it, I'll remember that the wifi is maple.", "Lo he guardado.", "Lisbon.", "No te lo recordaré."]) assert.equal(claimsReminder(s), false, s);
});

test("claimsAction: adversarial model output stays fast (patterns run on capped text; the lookbehinds are bounded)", () => {
  const t0 = process.cpuUsage();
  for (const unit of ["no te ", "no te lo ", "no ", "i m ", "let me ", "is are ", "te lo te lo "]) { claimsAction(unit.repeat(500) + "he anadido"); claimsReminder(unit.repeat(500) + "recordar"); }
  const d = process.cpuUsage(t0);
  assert.ok((d.user + d.system) / 1000 < 300, `${(d.user + d.system) / 1000} ms`);
});

test("claimsAction: known trade-offs, pinned (only ever read on an action turn no tool backed)", () => {
  assert.equal(claimsAction("You're all set."), true);
  assert.equal(claimsAction("Got it."), true, "an acknowledgement on an unbacked action turn is read as a claim");
});

test("claimsAction (code review I6/I7): openers before a bare claim are claims; ordinary sentences are not", () => {
  for (const s of ["Okay, added!", "Sure, done.", "Okay, got it.", "It's in your calendar.", "Your car appointment is in the calendar for Monday.",
    "Ok, listo.", "Vale, apuntado.", "Moved it to 9.", "Sure, should I add it?", "Your car appointment is scheduled for Monday at 8:15 AM.", "Lisbon. And I've added it."]) assert.equal(claimsAction(s), true, s);
  for (const s of ["The final is scheduled for July 19.", "What should I add?", "Sorry, I made a mistake.", "Let me put it this way.", "The game is set for 8pm.",
    "I'd love to make you laugh.", "I'll make it simple: Paris."]) assert.equal(claimsAction(s), false, s);
});

test("claimsAction: a claim at the END of a very long reply is still read", () => {
  assert.equal(claimsAction(`${"Lisbon is lovely. ".repeat(400)}I've added it to your calendar.`), true);
});

test("changesSomething: only a tool that changes something backs an action turn", () => {
  for (const n of ["ws_cal_create_event", "gcal_create_event", "gmail_send_to_self", "crow_store_memory", "phone_plan_call", "ws_cal_delete_event"]) assert.equal(changesSomething(n), true, n);
  for (const n of ["ws_cal_list_events", "gcal_get_event", "crow_search_memories", "tasks_list", "crow_discover", "gmail_search_threads", "", null]) assert.equal(changesSomething(n), false, String(n));
});
