/**
 * The voice helpers this bundle shares with the kiosk, imported from the kiosk bundle's source
 * in the app tree (never copied): the capped transcript text every matcher reads, the memory
 * intent test, the clock phrase table, the [Now] line and the action-intent tests. They are pure functions with no
 * state, so importing the app tree's copy is safe whether or not the kiosk is installed.
 * Phase 1 of the glasses revamp lifts them into servers/gateway/voice/; only this file changes then.
 * Note: this is the APP TREE's copy. The kiosk itself runs its installed copy, so until that copy
 * refreshes (a kiosk version bump), parity is with the repo, not with the running kiosk.
 */
import { appImport } from "./app-root.js";

const textMod = await appImport("bundles/kiosk/server/intent-text.js");
const memoryMod = await appImport("bundles/kiosk/server/memory-intent.js");
const clockMod = await appImport("bundles/kiosk/server/clock.js");
const actionMod = await appImport("bundles/kiosk/server/action-intent.js");

export const { intentText, INTENT_MAX_CHARS } = textMod;
export const { wantsMemory } = memoryMod;
/** → { say } for a plain time or date question (en, es), else null. */
export const { matchClockFastPath } = clockMod;
/** The [Now] line for the turn's user message (never the system message). */
export const nowContext = clockMod.kioskNowContext;
/** The [Dates] line (queue item 17a) and its trigger: added after [Now] when the transcript names a relative day. */
export const { relativeDatesContext, mentionsRelativeDay } = clockMod;
/** The kiosk's action-intent tests (queue item 29): does the transcript ask to do something, or follow one up. */
export const { wantsAction, wantsActionFollowUp } = actionMod;
