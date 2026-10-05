import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsMemory } from "../bundles/kiosk/server/memory-intent.js";

test("wantsMemory: only a request to remember, recall or forget offers the memory tool (en + es); plain questions do not", () => {
  const table = [
    // The live utterance: a plain question on a display with memories on.
    ["What's today's date?", false],
    ["What is today's date?", false],
    // Remember.
    ["Remember that the plumber comes on Friday", true],
    ["Please remember my wifi password is on the fridge", true],
    ["Don't forget that Sam is allergic to nuts", true],
    ["Do not forget the recycling goes out on Tuesday", true],
    ["Note that the spare key is under the mat", true],
    ["Save that for later", true],
    ["Make a note: buy stamps", true],
    ["Take a note that the car needs oil", true],
    ["Keep in mind that we are out of milk", true],
    // Recall.
    ["Recall what I said about the plumber", true],
    ["What did I tell you about the wifi?", true],
    ["What did I say about Friday?", true],
    ["Did I tell you when the plumber comes?", true],
    ["Do you remember the wifi password?", true],
    ["What do you know about me?", true],
    ["What do you know about my schedule?", true],
    ["What's my wifi password?", true],
    ["What is my dentist's name?", true],
    ["What are my plans for Friday?", true],
    ["Who is my dentist?", true],
    ["Who's my plumber?", true],
    ["When is my dentist appointment?", true],
    ["When's my next appointment?", true],
    ["Where did I put the spare key?", true],
    ["Check your memory for the wifi password", true],
    ["Search your memories for the plumber", true],
    // Forget.
    ["Forget that", true],
    ["Forget what I said about the plumber", true],
    // Plain questions and display requests.
    ["Tell me a joke", false],
    ["What time is it?", false],
    ["What is the capital of Portugal?", false],
    ["Who is the president of France?", false],
    ["When is Christmas?", false],
    ["What's the weather like?", false],
    ["What's a good recipe for pancakes?", false],
    ["Show me a list of three fruits.", false],
    ["set a timer for one minute and label it check", false],
    ["How do I save a file in Word?", false],
    ["Who wrote Unforgettable?", false],
    ["Take note of the time", false],
    ["", false],
    // Spanish.
    ["¿Qué día es hoy?", false],
    ["Cuéntame un chiste", false],
    ["¿Cuál es la capital de Portugal?", false],
    ["¿Quién es el presidente de Francia?", false],
    ["Recuerda que el fontanero viene el viernes", true],
    ["Acuérdate de que Sam es alérgico a las nueces", true],
    ["No olvides que la basura sale el martes", true],
    ["No te olvides de la cita", true],
    ["Anota que hay que comprar sellos", true],
    ["Apunta: comprar leche", true],
    ["Guárdalo para luego", true],
    ["Toma nota de que el coche necesita aceite", true],
    ["¿Te acuerdas de la contraseña del wifi?", true],
    ["¿Recuerdas cuándo viene el fontanero?", true],
    ["¿Qué te dije sobre el viernes?", true],
    ["¿Qué sabes de mí?", true],
    ["¿Qué sabes sobre mi horario?", true],
    ["¿Cuál es mi contraseña del wifi?", true],
    ["¿Quién es mi dentista?", true],
    ["¿Cuándo es mi cita con el dentista?", true],
    ["Olvida eso", true],
    ["Olvídalo", true],
    ["Busca en tu memoria el fontanero", true],
  ];
  for (const [text, want] of table) assert.equal(wantsMemory(text), want, JSON.stringify(text));
  assert.equal(wantsMemory("[Now] Sunday… remember\n\nTell me a joke"), true, "callers pass the PLAIN transcript, never the context prefix");
  for (const bad of [null, undefined, 7, {}]) assert.equal(wantsMemory(bad), false);
});
