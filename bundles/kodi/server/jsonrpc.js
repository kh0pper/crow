/**
 * Kodi JSON-RPC Client
 *
 * Sends JSON-RPC 2.0 requests to a Kodi instance over HTTP.
 * Uses native fetch() with 10s timeout and Basic auth support.
 */

let rpcId = 0;

export class KodiClient {
  /**
   * @param {{ url: string, user?: string, password?: string }} opts
   */
  constructor({ url, user, password }) {
    // Strip trailing slash
    this.url = url.replace(/\/+$/, "");
    this.headers = { "Content-Type": "application/json" };

    if (user && password) {
      const encoded = Buffer.from(`${user}:${password}`).toString("base64");
      this.headers["Authorization"] = `Basic ${encoded}`;
    }
  }

  /**
   * Send a JSON-RPC 2.0 call to Kodi.
   * @param {string} method - JSON-RPC method (e.g. "Player.GetActivePlayers")
   * @param {object} [params] - Method parameters
   * @returns {Promise<any>} - The "result" field from the JSON-RPC response
   */
  async call(method, params = {}) {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method,
      params,
    });

    let res;
    try {
      res = await fetch(`${this.url}/jsonrpc`, {
        method: "POST",
        headers: this.headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      if (err.name === "TimeoutError") {
        throw new Error(`Kodi request timed out after 10s. Is Kodi running at ${this.url}?`);
      }
      if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("ECONNREFUSED")) {
        throw new Error(`Kodi is not reachable at ${this.url}. Check that Kodi is running and HTTP control is enabled (Settings > Services > Web server).`);
      }
      throw new Error(`Cannot connect to Kodi at ${this.url}: ${err.message}`);
    }

    if (res.status === 401) {
      throw new Error("Kodi authentication failed. Check KODI_USER and KODI_PASSWORD.");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Kodi HTTP error ${res.status}: ${text}`);
    }

    const json = await res.json();
    if (json.error) {
      throw new Error(`Kodi JSON-RPC error: ${json.error.message || JSON.stringify(json.error)}`);
    }

    return json.result;
  }
}
