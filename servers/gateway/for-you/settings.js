/**
 * For You's settings (For You v1): which sections show, and the weather city. One local-scope
 * setting (dashboard_settings_overrides, never synced to paired instances), written only by the
 * owner's customize form (routes/for-you.js). The city is a name the operator typed, never a
 * position; `place` is what Open-Meteo's geocoder made of it, cached with the setting so the page
 * never geocodes on a GET.
 *
 *   { sections: { morning, listen, news, weather }, city: "", place: null | { name, admin1, country, lat, lon, unit } }
 */
import { readSetting, writeSetting } from "../dashboard/settings/registry.js";

export const SETTINGS_KEY = "for_you_settings";
export const SECTIONS = Object.freeze(["morning", "listen", "news", "weather"]);
export const CITY_MAX = 80;

const text = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** A geocoded place as stored, or null when it isn't one. */
export function normalizePlace(p) {
  if (!p || typeof p !== "object") return null;
  const lat = Number(p.lat), lon = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    name: text(p.name, CITY_MAX), admin1: text(p.admin1, CITY_MAX), country: text(p.country, CITY_MAX),
    lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4,
    unit: p.unit === "fahrenheit" ? "fahrenheit" : "celsius",
  };
}

/** Any stored value -> the full settings shape (every section on by default). */
export function normalizeSettings(raw) {
  const v = raw && typeof raw === "object" ? raw : {};
  const s = v.sections && typeof v.sections === "object" ? v.sections : {};
  const city = text(v.city, CITY_MAX);
  return {
    sections: Object.fromEntries(SECTIONS.map((k) => [k, s[k] !== false])),
    city,
    place: city ? normalizePlace(v.place) : null,
  };
}

export async function readForYouSettings(db) {
  let raw = null;
  try { raw = JSON.parse((await readSetting(db, SETTINGS_KEY)) || "null"); } catch { raw = null; }
  return normalizeSettings(raw);
}

/** Stored local-scope only, whatever the key's sync status. */
export async function writeForYouSettings(db, settings) {
  const v = normalizeSettings(settings);
  await writeSetting(db, SETTINGS_KEY, JSON.stringify(v), { scope: "local" });
  return v;
}
