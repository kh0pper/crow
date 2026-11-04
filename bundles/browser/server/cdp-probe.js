/**
 * Does this instance's DevTools endpoint answer, and is it gated?
 *
 * The dashboard panel and its status route share this one probe. It replaces the `curl`
 * they used to run, so the request can carry the instance's CDP bearer instead of a shell
 * argv (a token on a command line is visible in /proc to every process on the machine).
 *
 * "connected" means the endpoint answered 2xx. With a token configured:
 *   - 401 → the endpoint is gated and refused this token ("CDP token rejected");
 *   - a SEPARATE unauthenticated request that still answers 2xx → the gate is not in the
 *     container yet (a browser image older than the token), which the panel warns about.
 *     That request deliberately carries no token: it is testing the open door, not ours.
 * Without a token the probe is the plain unauthenticated request the curl did.
 */

const OK = (status) => status >= 200 && status < 300;

/** @returns {Promise<{connected: boolean, rejected: boolean, ungated: boolean}>} */
export async function probeCdp({ base, token = null, fetchImpl = globalThis.fetch, timeoutMs = 2000 } = {}) {
  const out = { connected: false, rejected: false, ungated: false };
  if (typeof base !== "string" || base === "") return out;
  let url;
  try { url = new URL("/json/version", base); } catch { return out; }
  const statusOf = async (headers) => {
    try {
      const r = await fetchImpl(url, { headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      return r && Number.isInteger(r.status) ? r.status : 0;
    } catch {
      return 0; // down, timed out, or redirected: not connected either way
    }
  };
  const usable = typeof token === "string" && token !== "";
  if (!usable) {
    out.connected = OK(await statusOf({}));
    return out;
  }
  out.ungated = OK(await statusOf({}));
  const status = await statusOf({ Authorization: `Bearer ${token}` });
  out.connected = OK(status);
  out.rejected = status === 401;
  return out;
}