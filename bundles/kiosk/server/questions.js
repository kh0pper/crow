/**
 * The 20 scripted short questions for the K1/K2 latency gate (spec §9, §13.2 A2/A5).
 * Chosen to be answerable in one sentence by the fast 4B with NO tool, and to
 * avoid every TOOL_INTENT_RE word (play, open, stop, show me, search, look up,
 * turn up, ...) so each one exercises the fast route — pinned by
 * tests/llm-router-voice-route.test.js. Ask them in this order, one per turn.
 */
export const LATENCY_QUESTIONS = Object.freeze([
  "What is the capital of Portugal?",
  "How many days are in a leap year?",
  "Give me a quick fun fact about octopuses.",
  "What is twelve times fourteen?",
  "How do you say thank you in Spanish?",
  "What rhymes with orange?",
  "Tell me a short joke.",
  "How many ounces are in a cup?",
  "What is the boiling point of water in Fahrenheit?",
  "Who wrote Pride and Prejudice?",
  "What is a good name for a goldfish?",
  "How far away is the moon, roughly?",
  "What is the opposite of ancient?",
  "How do you spell necessary?",
  "How many legs does a spider have?",
  "What color do you get mixing blue and yellow?",
  "What is the square root of eighty one?",
  "Name three kinds of citrus fruit.",
  "How long should I boil an egg for a soft yolk?",
  "What does a crow like to eat?",
]);
