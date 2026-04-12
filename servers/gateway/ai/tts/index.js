/**
 * TTS Provider Registry & Factory
 *
 * Mirrors the shape of ../provider.js for chat models. Each adapter:
 *   - `name`: string
 *   - `supportsStreaming`: boolean (true = chunked audio out; false = single buffer)
 *   - `synthesize(text, voice, options)` → async iterable of Uint8Array audio chunks
 *   - `listVoices()` → Promise<Array<{id, name, locale?, gender?}>> (empty = free-form)
 *
 * Adapters accept a profile config: { apiKey, baseUrl, defaultVoice }.
 * They do not self-read from the DB — call sites pass the profile in.
 */

const ADAPTER_LOADERS = {
  openai:     () => import("./adapters/openai.js"),
  azure:      () => import("./adapters/azure.js"),
  elevenlabs: () => import("./adapters/elevenlabs.js"),
  edge:       () => import("./adapters/edge.js"),
  piper:      () => import("./adapters/piper.js"),
  kokoro:     () => import("./adapters/kokoro.js"),
};

export const PROVIDER_INFO = {
  openai:     { name: "OpenAI TTS",       defaultVoice: "alloy",                requiresKey: true,  supportsStreaming: true  },
  azure:      { name: "Azure TTS",        defaultVoice: "en-US-JennyNeural",    requiresKey: true,  supportsStreaming: true  },
  elevenlabs: { name: "ElevenLabs",       defaultVoice: "EXAVITQu4vr4xnSDxMaL", requiresKey: true,  supportsStreaming: true  },
  edge:       { name: "Edge TTS",         defaultVoice: "en-US-JennyNeural",    requiresKey: false, supportsStreaming: false },
  piper:      { name: "Piper (self-host)",defaultVoice: "en_US-amy-medium",     requiresKey: false, supportsStreaming: true  },
  kokoro:     { name: "Kokoro (self-host)", defaultVoice: "af_bella",           requiresKey: false, supportsStreaming: true  },
};

/**
 * Read TTS profiles from dashboard_settings.
 * Returns array of profiles. Omit apiKey unless includeKeys is true.
 */
export async function getTtsProfiles(db, { includeKeys = false } = {}) {
  const result = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = 'tts_profiles'",
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
 * Create a TTS adapter from a profile config.
 * Returns { adapter, config }.
 */
export async function createTtsAdapter(profile) {
  if (!profile || !profile.provider) {
    throw Object.assign(new Error("TTS profile missing provider"), { code: "invalid_profile" });
  }
  const loader = ADAPTER_LOADERS[profile.provider];
  if (!loader) {
    throw Object.assign(
      new Error(`Unknown TTS provider: "${profile.provider}"`),
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
    defaultVoice: profile.defaultVoice || info?.defaultVoice || "",
  });
  return { adapter, config: profile };
}

/**
 * Find the default TTS profile (the one marked `isDefault: true`, or first).
 */
export async function getDefaultTtsProfile(db, { includeKeys = false } = {}) {
  const profiles = await getTtsProfiles(db, { includeKeys });
  if (profiles.length === 0) return null;
  return profiles.find(p => p.isDefault) || profiles[0];
}

/**
 * Synthesize text with the default profile (convenience wrapper).
 * Yields audio chunks.
 */
export async function* synthesizeDefault(db, text, options = {}) {
  const profile = await getDefaultTtsProfile(db, { includeKeys: true });
  if (!profile) {
    throw Object.assign(new Error("No TTS profile configured"), { code: "not_configured" });
  }
  const { adapter } = await createTtsAdapter(profile);
  const voice = options.voice || profile.defaultVoice;
  yield* adapter.synthesize(text, voice, options);
}

/**
 * Test a TTS profile by synthesizing a short sample.
 * Returns { ok, error?, bytes? }.
 */
export async function testTtsProfile(profile) {
  try {
    const { adapter } = await createTtsAdapter(profile);
    const voice = profile.defaultVoice || PROVIDER_INFO[profile.provider]?.defaultVoice;
    let total = 0;
    for await (const chunk of adapter.synthesize("Hello from Crow.", voice, {})) {
      total += chunk.length;
      if (total > 1024 * 1024) break; // safety cap
    }
    return { ok: total > 0, bytes: total };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code || "unknown" };
  }
}
