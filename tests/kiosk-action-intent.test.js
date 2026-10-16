import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsAction } from "../bundles/kiosk/server/action-intent.js";
import { LATENCY_QUESTIONS } from "../bundles/kiosk/server/questions.js";

test("wantsAction: a request to add, schedule, remind, send or delete is an action request (en + es)", () => {
  const yes = [
    // The live utterance (queue item 29).
    "Add a car appointment for 815am Monday to my calendar",
    "Schedule a dentist visit for Tuesday",
    "Remind me to call the plumber tomorrow",
    "Set a reminder for 5 pm",
    "Book a table for two on Friday",
    "Send an email to the landlord",
    "Delete my 3 o'clock meeting",
    "Cancel the appointment on Monday",
    "Put it on my calendar",
    "Add milk to my shopping list",
    "Create an event for Friday at noon",
    "Send an email to the landlord saying the rent is paid",
    "Email her the address",
    "Remember to buy stamps",
    "What's on my calendar tomorrow?",
    "Añade una cita para el lunes a las 8:15",
    "Agrega leche a la lista",
    "Agrega una cita para el lunes a mi calendario",
    "Crea un evento para el viernes",
    "Cancela mi cita del lunes",
    "Recuérdame llamar al fontanero",
    "Programa una reunión para el martes",
    "Envía un correo al casero",
    "Borra la cita del lunes",
    "Pon una alarma a las seis",
    "¿Qué tengo en el calendario?",
  ];
  for (const s of yes) assert.equal(wantsAction(s), true, s);
});

test("wantsAction: plain questions, media and display requests are not action requests", () => {
  const no = [
    "What is the capital of Portugal?",
    "What's today's date?",
    "How do I make pasta?",
    "Play some jazz",
    "Show me a timer for five minutes",
    "Set a timer for 10 minutes",
    "Turn it up",
    "Tell me a joke",
    // Plan review I3: bare verbs in plain questions.
    "Can you add 15 and 27?",
    "Create a short poem about dogs",
    "Recommend a good book",
    "How do I delete my instagram account?",
    "How do I set a reminder on my phone?",
    "Save me a seat",
    "Remove the weather card",
    "Add two minutes",
    "¿A qué hora es el programa?",
    "Dame una cita de Einstein",
    "¿Cuál es la capital de Portugal?",
    "Pon algo de jazz",
    "¿Qué hora es?",
    "",
  ];
  for (const s of no) assert.equal(wantsAction(s), false, s);
  assert.equal(wantsAction(null), false);
});

test("wantsAction: none of the scripted latency questions is an action request (the fast path stays fast)", () => {
  for (const q of LATENCY_QUESTIONS) assert.equal(wantsAction(q), false, q);
});
