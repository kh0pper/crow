/**
 * The voice helpers this bundle shares with the kiosk, imported from the kiosk bundle's source
 * in the app tree (never copied): the capped transcript text every matcher reads, the memory
 * intent test, the clock phrase table and the [Now] line. They are pure functions with no
 * state, so importing the app tree's copy is safe whether or not the kiosk is installed.
 * Phase 1 of the glasses revamp lifts them into servers/gateway/voice/; only this file changes then.
 * Note: this is the APP TREE's copy. The kiosk itself runs its installed copy, so until that copy
 * refreshes (a kiosk version bump), parity is with the repo, not with the running kiosk.
 */
import { appImport } from "./app-root.js";

const textMod = await appImport("bundles/kiosk/server/intent-text.js");
const memoryMod = await appImport("bundles/kiosk/server/memory-intent.js");
const clockMod = await appImport("bundles/kiosk/server/clock.js");

export const { intentText, INTENT_MAX_CHARS } = textMod;
export const { wantsMemory } = memoryMod;
/** → { say } for a plain time or date question (en, es), else null. */
export const { matchClockFastPath } = clockMod;
/** The [Now] line for the turn's user message (never the system message). */
export const nowContext = clockMod.kioskNowContext;
