/**
 * The display's bird (spec §5, rulings R18/R19): core readPortrait(db) — the
 * user's hatched Ramble bird with its decay-on-read mood and its outfit (the
 * same function the contacts portrait uses) — validated here; else the fixed
 * default crow (species crow, seed 0). readPortrait is injected (the gateway
 * glue passes servers/sharing/profile-avatar.js's), so tests need no Ramble.
 */
const ROSTER = new Set(["crow", "raven", "grackle", "magpie", "mockingbird", "hummingbird", "penguin", "blackswan"]);
const MOODS = new Set(["happy", "tired", "alarmed"]);
export const DEFAULT_BIRD = Object.freeze({ species: "crow", seed: 0, mood: "happy", outfit: null, source: "default" });

export async function resolveDisplayBird(db, { readPortrait }) {
  try {
    const p = await readPortrait(db);
    const seed = Number(p?.seed);
    if (p && ROSTER.has(String(p.species)) && Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff) {
      const outfit = p.outfit && typeof p.outfit === "object" && !Array.isArray(p.outfit) ? p.outfit : null;
      return { species: String(p.species), seed, mood: MOODS.has(p.mood) ? p.mood : "happy", outfit, source: "ramble" };
    }
  } catch { /* fall through to the default bird */ }
  return { ...DEFAULT_BIRD };
}
