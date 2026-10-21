/**
 * The baked-in voice-router model keys. A leaf module (no imports) so the
 * read-only consumer scan can report today's defaults without loading the
 * gateway router and its dependency graph. servers/gateway/routes/llm-router.js
 * applies the COMPANION_* env overrides on top of these.
 */
export const VOICE_ROUTE_DEFAULTS = Object.freeze({
  fast: "crow-voice/qwen3.5-4b",
  escalate: "crow-chat/qwen3.6-35b-a3b",
});
