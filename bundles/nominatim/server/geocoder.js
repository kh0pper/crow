/**
 * Nominatim GIS — Geocoder Client
 *
 * HTTP client for the self-hosted Nominatim API.
 * Supports forward geocoding, reverse geocoding, and structured search.
 */

const DEFAULT_URL = "http://localhost:8088";

function getBaseUrl() {
  return (process.env.NOMINATIM_URL || DEFAULT_URL).replace(/\/$/, "");
}

/**
 * Forward geocode: address/place name → lat/lng.
 * @param {string} query - Address or place name
 * @param {object} [options] - Additional options
 * @param {number} [options.limit=5] - Max results
 * @param {string} [options.countrycodes] - Comma-separated ISO country codes
 * @param {string} [options.viewbox] - Bounding box (lon1,lat1,lon2,lat2)
 * @returns {Promise<Array<{lat, lon, display_name, type, importance}>>}
 */
export async function geocode(query, options = {}) {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    addressdetails: "1",
    limit: String(options.limit || 5),
  });

  if (options.countrycodes) params.set("countrycodes", options.countrycodes);
  if (options.viewbox) {
    params.set("viewbox", options.viewbox);
    params.set("bounded", "1");
  }

  const resp = await fetchWithTimeout(`${getBaseUrl()}/search?${params}`);
  return resp;
}

/**
 * Reverse geocode: lat/lng → address.
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number} [zoom=18] - Zoom level (3=country, 10=city, 18=building)
 * @returns {Promise<{lat, lon, display_name, address}>}
 */
export async function reverseGeocode(lat, lon, zoom = 18) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    zoom: String(zoom),
    format: "jsonv2",
    addressdetails: "1",
  });

  const resp = await fetchWithTimeout(`${getBaseUrl()}/reverse?${params}`);
  return resp;
}

/**
 * Search for places by name/type within a bounding box.
 * @param {string} query - Search query
 * @param {object} [options]
 * @param {string} [options.viewbox] - Bounding box
 * @param {string} [options.countrycodes]
 * @param {number} [options.limit=10]
 * @returns {Promise<Array>}
 */
export async function searchPlaces(query, options = {}) {
  return geocode(query, { limit: options.limit || 10, ...options });
}

/**
 * Check if Nominatim is reachable.
 * @returns {Promise<{available: boolean, status?: object, error?: string}>}
 */
export async function checkStatus() {
  try {
    const resp = await fetchWithTimeout(`${getBaseUrl()}/status?format=json`, 3000);
    return { available: true, status: resp };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

/**
 * Fetch with timeout helper.
 */
async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!resp.ok) {
      throw new Error(`Nominatim returned HTTP ${resp.status}`);
    }

    return await resp.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      throw new Error(`Nominatim request timed out (${timeoutMs / 1000}s)`);
    }
    throw err;
  }
}
