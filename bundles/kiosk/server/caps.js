/**
 * Per-display capabilities, version 2. Two layers: what the page REPORTS it can draw (hello),
 * and the operator's PROFILE for the display (kiosk_settings.profile). The effective value is
 * the lesser of the two, computed here on the server: a page cannot grant itself more than its
 * profile, and a profile cannot promise what the page cannot draw. A K1 page (caps v1, or none)
 * is treated exactly as before.
 */
import { normalizeCaps } from "./wm.js";

export const PROFILES = Object.freeze({
  pi3: Object.freeze({ video: "none", youtube: "no", frames: 1, max_windows: 4 }),
  phone: Object.freeze({ video: "hd", youtube: "yes", frames: 1, max_windows: 4 }),
  tablet: Object.freeze({ video: "hd", youtube: "yes", frames: 2, max_windows: 4 }),
  desktop: Object.freeze({ video: "hd", youtube: "yes", frames: 3, max_windows: 6 }),
});
/** How a display with NO stored profile is read (never stored as data). */
export const DEFAULT_PROFILE = "pi3";
export const PAGE_KINDS = Object.freeze(["card", "app", "media", "camera", "launcher", "timer", "nowplaying", "toast", "choices"]);
/** The window store holds this many per display, whatever a profile allows. */
const STORE_MAX_WINDOWS = 4;
const int = (v, lo, hi, d) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : d);

/**
 * The pairing guess (spec §12.2): from what the page reported in hello. A phone says it is mobile; a
 * small screen on an ARM Linux browser is the Pi kiosk; a coarse pointer with a larger screen is a
 * tablet; anything else with a screen is a desktop. A K1 page (no caps v2) gives no guess. → name | null.
 */
export function guessProfile(raw) {
  if (!raw || typeof raw !== "object" || raw.v !== 2) return null;
  const w = int(raw.screen?.w, 0, 10000, 0), h = int(raw.screen?.h, 0, 10000, 0);
  if (raw.mobile === true) return "phone";
  if (/^linux (aarch64|armv\d)/i.test(String(raw.platform || "").slice(0, 40)) && Math.max(w, h) > 0 && Math.max(w, h) <= 1024) return "pi3";
  if (raw.pointer === "coarse") return Math.min(w, h) > 0 && Math.min(w, h) < 600 ? "phone" : "tablet";
  return w > 0 ? "desktop" : null;
}

export function effectiveCaps(raw, profileName) {
  // No profile set (or one this build does not know): the audio-first profile. A display gets video only
  // when someone has said what it is, or the pairing guess (a later slice) has.
  const profile = Object.hasOwn(PROFILES, profileName) ? PROFILES[profileName] : PROFILES[DEFAULT_PROFILE];
  const r = raw && typeof raw === "object" ? raw : {};
  const v2 = r.v === 2;
  const v1 = normalizeCaps(v2 ? null : r);
  const kinds = v2
    ? [...new Set((Array.isArray(r.kinds) ? r.kinds : []).filter((k) => PAGE_KINDS.includes(k)))]
    : [...(v1.windows.some((k) => k !== "timer") ? ["card"] : []), ...(v1.windows.includes("timer") ? ["timer"] : [])];
  // The K1 window kinds the store and the card tool understand.
  const windows = v2 ? [...(kinds.includes("timer") ? ["timer"] : []), ...(kinds.includes("card") ? ["recipe", "content"] : [])] : v1.windows;
  const framed = kinds.includes("app") || kinds.includes("media");
  const frames = framed ? Math.min(profile.frames, int(r.frames, 0, 4, profile.frames)) : 0;
  const video = kinds.includes("media") ? profile.video : "none";
  return {
    v: 2,
    screen: { w: int(r.screen?.w, 0, 10000, 0), h: int(r.screen?.h, 0, 10000, 0), touch: r.screen?.touch !== false },
    audio: { out: r.audio?.out !== false, in: r.audio?.in !== false },
    video,
    codecs: [],
    youtube: video !== "none" && frames > 0 && profile.youtube === "yes" ? "yes" : "no",
    frames,
    max_windows: Math.min(STORE_MAX_WINDOWS, profile.max_windows, v2 ? int(r.max_windows, 1, 6, 6) : v1.max_windows),
    // wake_over_media is a bench result stored on the device, never a claim from the page.
    input: { wake: r.input?.wake === true, keyboard: r.input?.keyboard === true, wake_over_media: "untested" },
    kinds, windows, iframe: false,
  };
}
