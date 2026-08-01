/**
 * Where the hub's bearer token comes from.
 *
 * Standalone Perch reads it from ~/.pi/agent/settings.json ("pi-webserver".apiToken).
 * Embedded in Crow, the supervising gateway mints the token and hands it over in
 * PERCH_API_TOKEN — there is no settings.json to share. Env wins; the settings
 * reader stays the unchanged fallback; nothing at all means null, so auth fails
 * closed rather than matching a phantom empty token.
 */
export function apiTokenFromEnv(env, readSettingsToken) {
	return env.PERCH_API_TOKEN || readSettingsToken() || null;
}
