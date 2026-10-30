/**
 * For You's weather chip (For You v1), from Open-Meteo (no key).
 *
 *   geocodeCity(city, opts)  -> a place ({ name, admin1, country, lat, lon, unit }) or null
 *   weatherFor(place, opts)  -> { temp, code, high, low, rain, unit } or null (no chip)
 *
 * Fetched server-side from two fixed hosts only (GEO_HOST, FORECAST_HOST): the URL is built here
 * from constants and the place's numbers, never from request input, and checked against the pair
 * before any fetch. Each fetch times out after FETCH_TIMEOUT_MS. A forecast is cached for
 * CACHE_MS per place; a stale entry is served at once while a refresh runs in the background, so
 * only a cold miss waits (at most the timeout). A failure is remembered for FAIL_MS and means no
 * chip, never an error on the page.
 *
 * LICENSING: Open-Meteo's free API is for non-commercial use and asks for attribution (the page
 * shows "Weather: Open-Meteo"). Any commercial use of Crow (hosted plans, a paid product) needs a
 * review of their terms first, or their commercial API plan.
 */

export const GEO_HOST = "geocoding-api.open-meteo.com";
export const FORECAST_HOST = "api.open-meteo.com";
const ALLOWED_HOSTS = new Set([GEO_HOST, FORECAST_HOST]);
export const FETCH_TIMEOUT_MS = 2500;
export const CACHE_MS = 30 * 60 * 1000;
export const FAIL_MS = 5 * 60 * 1000;
const CACHE_MAX = 32;
/** Countries whose people read temperatures in Fahrenheit. */
const FAHRENHEIT = new Set(["US", "LR", "MM", "BS", "BZ", "KY", "PW", "FM", "MH"]);

const cache = new Map(); // key -> { at, value, ok, pending }

/** Forget every cached forecast (tests). */
export function clearWeatherCache() { cache.clear(); }

/** fetch(url) JSON from an allowed host, with the timeout; throws on anything else. */
async function getJson(url, fetchImpl) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) throw new Error(`weather: refused host ${u.hostname}`);
  const r = await fetchImpl(u.href, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json" }, redirect: "error" });
  if (!r.ok) throw new Error(`weather: HTTP ${r.status}`);
  return r.json();
}

/** The first match for a typed city name, or null. Throws on a network failure (the caller says so). */
export async function geocodeCity(city, { fetchImpl = fetch, lang = "en" } = {}) {
  const name = String(city ?? "").trim();
  if (!name) return null;
  const u = new URL(`https://${GEO_HOST}/v1/search`);
  u.searchParams.set("name", name.slice(0, 80));
  u.searchParams.set("count", "1");
  u.searchParams.set("language", lang === "es" ? "es" : "en");
  u.searchParams.set("format", "json");
  const body = await getJson(u.href, fetchImpl);
  const hit = body && Array.isArray(body.results) ? body.results[0] : null;
  if (!hit || !Number.isFinite(Number(hit.latitude)) || !Number.isFinite(Number(hit.longitude))) return null;
  return {
    name: String(hit.name || name), admin1: String(hit.admin1 || ""), country: String(hit.country || ""),
    lat: Number(hit.latitude), lon: Number(hit.longitude),
    unit: FAHRENHEIT.has(String(hit.country_code || "").toUpperCase()) ? "fahrenheit" : "celsius",
  };
}

function forecastUrl(place) {
  const u = new URL(`https://${FORECAST_HOST}/v1/forecast`);
  u.searchParams.set("latitude", String(Number(place.lat)));
  u.searchParams.set("longitude", String(Number(place.lon)));
  u.searchParams.set("current", "temperature_2m,weather_code");
  u.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max");
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("forecast_days", "1");
  u.searchParams.set("temperature_unit", place.unit === "fahrenheit" ? "fahrenheit" : "celsius");
  return u.href;
}

/** Open-Meteo's body -> the chip's numbers, or null when the current temperature is missing. */
export function parseForecast(body, unit) {
  const cur = body && body.current;
  const day = body && body.daily;
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const first = (a) => (Array.isArray(a) ? num(a[0]) : null);
  const temp = num(cur && cur.temperature_2m);
  if (temp == null) return null;
  return {
    temp: Math.round(temp),
    code: num(cur.weather_code),
    high: first(day && day.temperature_2m_max) == null ? null : Math.round(first(day.temperature_2m_max)),
    low: first(day && day.temperature_2m_min) == null ? null : Math.round(first(day.temperature_2m_min)),
    rain: first(day && day.precipitation_probability_max),
    unit: unit === "fahrenheit" ? "fahrenheit" : "celsius",
  };
}

async function refresh(key, place, fetchImpl, now) {
  try {
    const value = parseForecast(await getJson(forecastUrl(place), fetchImpl), place.unit);
    cache.set(key, { at: now(), value, ok: value != null });
  } catch (err) {
    console.warn(`[for-you] weather fetch failed: ${err && err.message}`);
    cache.set(key, { at: now(), value: null, ok: false });
  }
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return cache.get(key).value;
}

/** Today's weather for a stored place, or null (no place, no data, or a recent failure). */
export async function weatherFor(place, { fetchImpl = fetch, now = Date.now } = {}) {
  if (!place || !Number.isFinite(Number(place.lat)) || !Number.isFinite(Number(place.lon))) return null;
  const key = `${Number(place.lat)},${Number(place.lon)},${place.unit === "fahrenheit" ? "f" : "c"}`;
  const hit = cache.get(key);
  if (hit && !hit.pending) {
    const age = now() - hit.at;
    if (hit.ok && age < CACHE_MS) return hit.value;
    if (!hit.ok && age < FAIL_MS) return null;
    if (hit.ok) {
      // Stale: serve it now and refresh behind the page.
      hit.pending = true;
      refresh(key, place, fetchImpl, now).catch(() => {});
      return hit.value;
    }
  }
  if (hit && hit.pending) return hit.ok ? hit.value : null;
  return refresh(key, place, fetchImpl, now);
}

/** A WMO weather code -> the i18n suffix for its words (forYou.wx.<kind>). */
export function weatherKind(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return null;
  if (c === 0) return "clear";
  if (c === 1 || c === 2) return "partly";
  if (c === 3) return "cloudy";
  if (c === 45 || c === 48) return "fog";
  if (c >= 51 && c <= 57) return "drizzle";
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return "rain";
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "snow";
  if (c >= 95 && c <= 99) return "storm";
  return null;
}
