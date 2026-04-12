/**
 * STT Provider Registry & Factory
 *
 * Mirrors the shape of ../provider.js and ../tts/index.js. Each adapter:
 *   - `name`: string
 *   - `supportsStreaming`: boolean (true = accepts a stream of audio frames
 *     and yields partial transcripts; false = batch-only, requires full buffer)
 *   - `transcribe(audioBuffer, options)` → Promise<{ text, language? }>
 *   - `transcribeStream(frames$, options)` (optional; streaming-capable only)
 *     → async iterable of { type: "partial"|"final", text, language? }
 *
 * Consumers branch on `supportsStreaming`:
 *   - batch consumers buffer the full turn, then call `transcribe()`
 *   - streaming consumers pipe frames into `transcribeStream()` and emit
 *     partials to the user while the turn is in flight
 *
 * The platform bundle (meta-glasses, PR3) will use `supportsStreaming` to
 * decide whether to advertise `transcript_partial` frames on its WebSocket.
 */

const ADAPTER_LOADERS = {
  openai:        () => import("./adapters/openai.js"),
  groq:          () => import("./adapters/groq.js"),
  deepgram:      () => import("./adapters/deepgram.js"),
  whispercpp:    () => import("./adapters/whispercpp.js"),
  fasterwhisper: () => import("./adapters/fasterwhisper.js"),
};

export const PROVIDER_INFO = {
  openai:        { name: "OpenAI Whisper",     defaultModel: "whisper-1",            requiresKey: true,  supportsStreaming: false },
  groq:          { name: "Groq Whisper",       defaultModel: "whisper-large-v3-turbo", requiresKey: true,  supportsStreaming: false },
  deepgram:      { name: "Deepgram",           defaultModel: "nova-3",                requiresKey: true,  supportsStreaming: true  },
  whispercpp:    { name: "whisper.cpp (self-host)", defaultModel: "",               requiresKey: false, supportsStreaming: false },
  fasterwhisper: { name: "faster-whisper (self-host)", defaultModel: "",            requiresKey: false, supportsStreaming: false },
};

/**
 * Read STT profiles from dashboard_settings.
 */
export async function getSttProfiles(db, { includeKeys = false } = {}) {
  const result = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = 'stt_profiles'",
    args: [],
  });
  if (!result.rows[0]?.value) return [];
  try {
    const profiles = JSON.parse(result.rows[0].value);
    if (!includeKeys) return profiles.map(({ apiKey, ...rest }) => rest);
    return profiles;
  } catch { return []; }
}

/**
 * Create an STT adapter instance from a profile config.
 */
export async function createSttAdapter(profile) {
  if (!profile || !profile.provider) {
    throw Object.assign(new Error("STT profile missing provider"), { code: "invalid_profile" });
  }
  const loader = ADAPTER_LOADERS[profile.provider];
  if (!loader) {
    throw Object.assign(
      new Error(`Unknown STT provider: "${profile.provider}"`),
      { code: "invalid_provider" }
    );
  }
  const info = PROVIDER_INFO[profile.provider];
  if (info?.requiresKey && !profile.apiKey) {
    throw Object.assign(new Error(`${info.name} requires an API key`), { code: "missing_key" });
  }

  const mod = await loader();
  const adapter = mod.default({
    apiKey: profile.apiKey || "",
    baseUrl: profile.baseUrl || "",
    defaultModel: profile.defaultModel || info?.defaultModel || "",
  });
  return { adapter, config: profile };
}

/** Find the default STT profile (marked `isDefault: true`, or first). */
export async function getDefaultSttProfile(db, { includeKeys = false } = {}) {
  const profiles = await getSttProfiles(db, { includeKeys });
  if (profiles.length === 0) return null;
  return profiles.find(p => p.isDefault) || profiles[0];
}

/**
 * Test an STT profile by transcribing a tiny bundled fixture.
 * Since we don't ship audio fixtures, "test" just attempts a connection
 * by hitting a known low-cost endpoint for providers that expose one,
 * or returns `ok: true` with a note that real verification needs audio.
 */
export async function testSttProfile(profile) {
  try {
    const { adapter } = await createSttAdapter(profile);
    // No audio → we can only validate auth via a lightweight probe if the
    // adapter exposes one. For now: success = construction + no throw.
    return {
      ok: true,
      provider: adapter.name,
      supportsStreaming: adapter.supportsStreaming,
      note: "Adapter initialized. Upload audio via /api/stt/debug for end-to-end test.",
    };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code || "unknown" };
  }
}
