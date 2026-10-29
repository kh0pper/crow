import { test } from "node:test";
import assert from "node:assert/strict";
import { claimsAction, claimsReminder, claimsBeyondMemory, claimText, changesSomething, toolEffect, CLAIM_MAX_CHARS, needsSpokenYes } from "../servers/gateway/voice/action-claims.js";

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

test("claimsAction: a state-style reply that says the item now exists is a claim (#499; en + es)", () => {
  for (const s of [
    "Coffee is booked for Tuesday.",
    // Re-review ruling: booked / added / saved / created / put on take ANY subject, articles included.
    "The coffee is booked for Tuesday.",
    "The dentist is booked for Friday.",
    "Lunch with the team was added for noon.",
    "Okay, coffee with Sam on Tuesday at 9 is on your calendar.",
    "Coffee's booked on Tuesday at nine.",
    "Your calendar now has coffee on Tuesday.",
    "It's on your calendar.",
    "Lunch is set for noon.",
    "Milk is on your list.",
    "The reminder is set.",
    "Okay, milk is on your list.",
    "Está en tu calendario.",
    "Quedó agendado.",
    "Ya está en tu lista.",
    "El recordatorio está puesto.",
  ]) assert.equal(claimsAction(s), true, s);
});

test("claimsAction: a question, a read answer or a plain fact about a day is not a state claim (#499)", () => {
  for (const s of [
    "Is coffee on Tuesday?",
    "What's on Tuesday?",
    "Tuesday is a busy day.",
    // The state half alone; the offer half ("want me to add it?") is an offer, which the guard already counts.
    "The meeting is on Tuesday.",
    "Nothing is on your calendar Tuesday.",
    "Okay, nothing is on your calendar Tuesday.",
    "What else is on your list?",
    "Your calendar has three events on Tuesday.",
    "It's sunny and 72 degrees today, with a light breeze.",
    "The forecast is set to clear up by noon.",
    "The game's on Tuesday at nine.",
    // Re-review ruling: "X's on <day>" / "X's at <time>" with no add verb is a plain fact or a calendar read answer.
    "Coffee's on Tuesday at nine.",
    "Your dentist's on Friday at nine.",
    "Halloween's on Friday.",
    "Payday's on Friday.",
    "Dinner's at noon.",
    "Your meeting's on Tuesday.",
    "Mom's birthday's on Sunday.",
    "It's on Tuesday.",
    "El recordatorio no está puesto.",
  ]) assert.equal(claimsAction(s), false, s);
  // The full sentence is still a claim, through its offer ("Want me to set a reminder?" always was).
  assert.equal(claimsAction("The meeting is on Tuesday, want me to add it?"), true);
});

// CPU time of fn, in ms. A fixed bound in ms flakes on a loaded CI runner, so the speed tests compare
// against a control of the same length measured in the same run (plain words no pattern dwells on), with
// a wide absolute ceiling as a backstop: catastrophic backtracking on capped text costs seconds and
// hundreds of times the control, while a busy runner slows both sides alike.
const cpuMs = (fn) => {
  const t0 = process.cpuUsage();
  fn();
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
};
const MAX_RATIO = 25;
const MAX_MS = 5000;
// The control gets a floor so a near-zero measurement can't make the ratio meaningless.
const assertLinear = (adversarialMs, controlMs, label) => {
  const budget = Math.min(MAX_MS, MAX_RATIO * Math.max(controlMs, 20));
  assert.ok(adversarialMs < budget, `${label}: ${adversarialMs.toFixed(1)} ms vs control ${controlMs.toFixed(1)} ms (budget ${budget.toFixed(0)} ms)`);
};

test("claimText: capped before any pattern runs; long repetitive input is fast", () => {
  assert.equal(claimText("x".repeat(CLAIM_MAX_CHARS + 500)).length, CLAIM_MAX_CHARS);
  const units = ["i ve ", "i ll also ", "te lo ", "he ", "it s all ", "would you like me to ", "a"];
  const control = cpuMs(() => { for (const unit of units) claimsAction("lorem ipsum ".repeat(Math.ceil(unit.length * 1000 / 12)) + "?"); });
  const adversarial = cpuMs(() => { for (const unit of units) claimsAction(unit.repeat(1000) + "?"); });
  assertLinear(adversarial, control, "linear patterns on capped text");
});

test("claimsAction: Spanish negations are not claims", () => {
  for (const s of ["No he añadido nada.", "No te lo he puesto en el calendario.", "No voy a poder agregarlo.", "No puedo recordarte nada desde aquí.", "Todavía no está programada."]) assert.equal(claimsAction(s), false, s);
});

test("claimsReminder: a promised reminder or follow-up, which a saved memory is not", () => {
  for (const s of ["I'll remind you at 5.", "I'd be happy to remind you.", "I'll let you know tomorrow.", "Te lo recuerdo el lunes.", "Te avisaré mañana."]) assert.equal(claimsReminder(s), true, s);
  for (const s of ["I've saved that.", "Got it, I'll remember that the wifi is maple.", "Lo he guardado.", "Lisbon.", "No te lo recordaré."]) assert.equal(claimsReminder(s), false, s);
});

test("claimsAction: adversarial model output stays fast (patterns run on capped text; the lookbehinds are bounded)", () => {
  const units = ["no te ", "no te lo ", "no ", "i m ", "let me ", "is are ", "te lo te lo ", "que lo ", "me ", "writer y "];
  const run = (pad) => { for (const unit of units) {
    const head = pad(unit);
    claimsAction(head + "he anadido"); claimsReminder(head + "recordar");
    claimsAction(head + "pare"); claimsAction(head + "esta en ello"); claimsAction(head + "ya empezo");
  } };
  const control = cpuMs(() => run((unit) => "lorem ipsum ".repeat(Math.ceil(unit.length * 500 / 12))));
  const adversarial = cpuMs(() => run((unit) => unit.repeat(500)));
  assertLinear(adversarial, control, "adversarial model output");
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

test("toolEffect: the real add-on names, camelCase and hyphens; the first verb decides (find_replace is a write)", () => {
  for (const n of ["ws_cal_create_event", "ws_cal_update_event", "ws_cal_delete_event", "ws_cal_respond_to_event", "ws_contacts_create", "gcal_create_event", "gmail_send_to_self",
    "gmail_create_draft", "crow_voice_memo", "crow_crosspost", "crow_react", "crow_dismiss_notification", "ws_change_status", "ws_undo_last_change", "ws_drive_restore_version",
    "gdocs_find_replace", "gdocs_rewrite_passages", "gdocs_resolve_comment", "gslides_duplicate_slide", "gslides_reorder_slides", "gdrive_transfer_ownership", "bigquery_sync_sheet_to_table",
    "createEvent", "create-event", "crow_create_schedule"]) assert.equal(toolEffect(n), "write", n);
  for (const n of ["ws_cal_list_events", "gcal_get_event", "gmail_search_threads", "crow_search_memories", "tasks_list", "crow_discover",
    "crow_get_post", "list_new_messages", "get_call_log", "get_order_status", "search_start_time"]) assert.equal(toolEffect(n), "read", n);
  for (const n of ["acme_frobnicate", "", null]) assert.equal(toolEffect(n), "unknown", String(n));
  assert.equal(changesSomething("gcal_create_event"), true);
});

test("claimsBeyondMemory: a save that names a calendar, list or message is not a memory save (en + es)", () => {
  for (const s of ["I've saved it to your calendar.", "Lo he guardado en tu calendario.", "I've saved that. I'll remind you at 5."]) assert.equal(claimsBeyondMemory(s), true, s);
  for (const s of ["I've saved that.", "Got it, I'll remember that the wifi is maple.", "Lo he guardado."]) assert.equal(claimsBeyondMemory(s), false, s);
});

test("needsSpokenYes: a tool whose first verb deletes, changes or sends asks for a spoken yes; a create, a save, a play or a read does not", () => {
  for (const n of ["ws_cal_delete_event", "gmail_send_to_self", "ws_cal_update_event", "gdrive_move_file", "crow_update_memory",
    "gdocs_find_replace", "crow_publish_post", "gdrive_trash_file", "crow_dismiss_notification", "gdrive_rename", "crow_share_post",
    "sheets_write", "gdrive_upload_new_version", "gdocs_apply_comment_edit", "crow_crosspost", "crow_revoke_access"]) assert.equal(needsSpokenYes(n), true, n);
  assert.equal(toolEffect("crow_revoke_access"), "write");
  assert.equal(toolEffect("crow_revoke_instance"), "write");
  for (const n of ["ws_cal_create_event", "crow_store_memory", "fw_play", "ws_cal_list_events", "crow_create_schedule", "gmail_create_draft", "acme_frobnicate", "", null]) assert.equal(needsSpokenYes(n), false, String(n));
});

test("claimsAction: a hand-off claimed as started is a claim (en + es) [rev2 C1]; a refusal or a negation is not", () => {
  for (const t of [
    "I'm on it!", "I am on it.", "They're on it.", "It's on it now.", "He's on it.", "The bots are on it.", "Your assistant is on it.",
    "Writer has started.", "They have begun.",
    "Writer is working on it.", "Writer's now working on that.", "Writer is starting.", "Writer's now starting on it.", "It has started.", "Writer has started on it.", "Hank has started on that.", "Writer has started already.", "Writer is starting in on it.",
    "I've handed it to Writer.", "I have passed this over to Helper.", "I handed that off to Writer.",
    "I've given it to Writer.", "I sent it over to Helper.", "I forwarded this to Writer.",
    "Writer se pone con ello.", "Ya está con ello.", "Ya ha empezado.", "Han empezado.",
    "Se lo pasé a Writer.", "Se lo he pasado a Writer.",
  ]) assert.equal(claimsAction(t), true, t);
  for (const t of [
    "I can't hand that to Writer.", "I can't pass it to Writer from here.",
    "No se lo he pasado a Writer.", "No ha empezado.", "Writer no se pone con ello.",
  ]) assert.equal(claimsAction(t), false, t);
});

test("claimsAction: \"<X> is on it\" is a hand-off claim only about an agent or a bot the turn could reach (opts.agents)", () => {
  const agents = ["Writer", "Helper", "research-bot"];
  for (const t of ["Writer's on it!", "Writer is on it.", "Helper and Writer're on it.", "Writer is already on it.", "Research-bot is on it."]) {
    assert.equal(claimsAction(t, { agents }), true, t);
    assert.equal(claimsReminder(`${t} I'll remind you later.`, { agents }), true, t);
    assert.equal(claimsBeyondMemory(t, { agents }), true, t);
  }
  assert.equal(claimsAction("Writer's on it!"), false, "no agents: a plain noun");
});

test("claimsAction: read answers and things that start on their own are not hand-off claims (fix round 1)", () => {
  const agents = ["Writer", "Helper"];
  for (const t of [
    "Here's what's on it: milk and eggs.", "Here is what is on it.", "What's on it?", "Milk and eggs are on it.", "Milk is on it.", "The lid is on it.",
    "The movie has started.", "Your timer has started.", "The meeting has started already.", "The game has begun.", "Has it started yet?",
    "It's starting to rain at three.", "The movie is starting at eight.", "Your dentist is now starting at nine.",
    "The class is starting on Monday.", "The sale is starting in an hour.",
  ]) {
    assert.equal(claimsAction(t, { agents }), false, t);
    assert.equal(claimsAction(t), false, t);
  }
});

test("claimsAction: a start with a time, a span or the weather after it, or a Spanish thing that starts on its own, is no claim (fix round 2)", () => {
  for (const t of [
    "It has started to rain.", "It has started raining.", "Writer's show has started on Monday.", "It has started at noon.",
    "The movie is starting in five minutes.", "Writer is starting in an hour.", "The class is starting 9 sharp.",
    "La película ya ha empezado.", "El partido ha empezado.", "La reunión ha empezado.", "El temporizador ya ha empezado.",
  ]) assert.equal(claimsAction(t, { agents: ["Writer"] }), false, t);
  for (const t of ["Writer ya ha empezado.", "Han empezado."]) assert.equal(claimsAction(t), true, t);
});

test("claimsAction: a first-person stop is a held claim; a thing that stopped on its own is not (PR 6 carry)", () => {
  for (const t of [
    "Okay, I stopped Writer.", "I've halted it.", "I have stopped the research.", "I just stopped it.", "I halted Writer's task.",
    "Paré la tarea de Writer.", "Vale, detuve a Writer.", "He parado la tarea.", "Lo he detenido.", "Ya he parado a Writer.", "La detuve.", "Cancelé la tarea.",
  ]) assert.equal(claimsAction(t, { agents: ["Writer"] }), true, t);
  for (const t of [
    "The rain stopped.", "The music has stopped.", "It stopped raining.", "Your timer has stopped.", "Writer stopped by earlier.",
    "La lluvia paró.", "La música se detuvo.", "No he parado nada.", "No lo detuve.", "Espero que pare la lluvia.", "¿Quieres que lo pare?",
    "Me detuve a pensar.", "Me he parado en la esquina.",
  ]) assert.equal(claimsAction(t, { agents: ["Writer"] }), false, t);
});

test("claimsAction: the Spanish hand-off claims, with an agent subject where the sentence has one (PR 6 carry)", () => {
  const agents = ["Writer", "Helper"];
  for (const t of [
    "Writer está en ello.", "Writer ya está en ello.", "Writer y Helper están en ello.", "El agente está en ello.", "Ya está en ello.", "Está en ello.", "Vale ya está en ello.", "Estoy en ello.",
    "Le pasé la tarea a Writer.", "Le he pasado la tarea a Helper.", "Le encargué la investigación a Writer.", "Le he encargado el informe a Writer.", "Ya le pasé el encargo.",
    "Writer ya empezó.", "El asistente ya empezó con la tarea.", "Helper comenzó.",
  ]) assert.equal(claimsAction(t, { agents }), true, t);
  for (const t of [
    "Writer no está en ello.", "No estoy en ello.", "Todavía no está en ello.", "La tapa está en ello.",
    "Todavía no le pasé la tarea a Writer.", "Espero que no le pase nada.", "Lo que le pase a tu coche.", "Cuando le pase algo, avísame.",
    "La película ya empezó.", "Ya empezó.", "La lluvia ya empezó.", "El partido comenzó a las ocho.",
  ]) assert.equal(claimsAction(t, { agents }), false, t);
  // As in English, "<X> está en ello" / "<X> ya empezó" names an agent only when X is one.
  for (const t of ["Writer está en ello.", "Writer ya empezó."]) assert.equal(claimsAction(t), false, `no agents: ${t}`);
});

test("claimsAction: Spanish subjunctives and a start with a time are no claims (6.3 fix round 2)", () => {
  const agents = ["Writer"];
  for (const t of [
    "Saldremos cuando pare la lluvia.", "Ojalá pare pronto.", "En cuanto pare la lluvia salimos.", "Si pare, avísame.", "Aunque pare, sigue.", "Mientras pare el tráfico, espera.",
    "Que se lo pase bien.", "Espero que se lo pase bien.",
    "El equipo comenzó a las ocho.", "Writer empezó a la una.", "El equipo empezó el lunes.", "Writer comenzó 9 en punto.", "El equipo empezó a llover.",
  ]) assert.equal(claimsAction(t, { agents }), false, t);
  for (const t of ["Paré la tarea de Writer.", "Se lo pasé a Writer.", "Writer ya empezó.", "El equipo comenzó a trabajar en ello."]) assert.equal(claimsAction(t, { agents }), true, t);
});
