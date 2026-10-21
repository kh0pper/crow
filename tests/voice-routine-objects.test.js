import { test } from "node:test";
import assert from "node:assert/strict";
import { ROUTINE_OBJECTS, ROUTINE_OBJECT_LISTS, namesRoutineObjects } from "../servers/gateway/voice/routine-objects.js";
import { phraseWords, listMatches } from "../servers/gateway/voice/tool-families.js";
import { ACTION_OBJECTS } from "../bundles/kiosk/server/action-intent.js";

/** ACTION_OBJECTS `thing` entries are regex fragments: "reminders?" stands for "reminder" and "reminders". */
const expand = (thing) => (thing.endsWith("s?") ? [thing.slice(0, -1), thing.slice(0, -2)] : [thing]);

test("every calendar and reminder object word of the kiosk's action intent is matched by the core list", () => {
  for (const id of ["calendar", "reminders"]) {
    const obj = ACTION_OBJECTS.find((o) => o.id === id);
    assert.ok(obj, id);
    for (const thing of obj.thing) for (const w of expand(thing)) {
      assert.ok(listMatches(phraseWords(w), ROUTINE_OBJECT_LISTS[id]), `${id}: "${w}"`);
    }
  }
});

test("the three objects, en and es", () => {
  assert.deepEqual(Object.keys(ROUTINE_OBJECTS).sort(), ["calendar", "reminders", "tasks"]);
  for (const v of Object.values(ROUTINE_OBJECTS)) { assert.ok(v.en.length > 0); assert.ok(v.es.length > 0); }
});

test("names: schedule is a calendar; 'remember to do' is not a task; a to-do list is", () => {
  assert.deepEqual(namesRoutineObjects("add lunch to my schedule"), ["calendar"]);
  assert.deepEqual(namesRoutineObjects("remember to do the dishes tonight"), []);
  assert.deepEqual(namesRoutineObjects("put milk on my to-do list"), ["tasks"]);
  assert.deepEqual(namesRoutineObjects("añade una tarea"), ["tasks"]);
  assert.deepEqual(namesRoutineObjects("recuérdame llamar a alex"), ["reminders"]);
});
