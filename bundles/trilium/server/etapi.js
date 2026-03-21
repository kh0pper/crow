/**
 * TriliumNext ETAPI Client
 *
 * Lightweight HTTP client for TriliumNext's External API (ETAPI).
 * Auth via token header, 10s timeout, graceful error handling.
 */

export class EtapiClient {
  /**
   * @param {object} opts
   * @param {string} opts.url — TriliumNext base URL (e.g., http://localhost:8088)
   * @param {string} opts.token — ETAPI token
   */
  constructor({ url, token }) {
    this.baseUrl = url.replace(/\/+$/, "");
    this.token = token;
  }

  /**
   * Make an authenticated request to the ETAPI.
   * @param {string} method — HTTP method
   * @param {string} path — ETAPI path (without /etapi/ prefix)
   * @param {any} [body] — Request body (will be JSON-stringified)
   * @returns {Promise<any>} Parsed JSON response, or null for 204/empty
   */
  async request(method, path, body) {
    const url = `${this.baseUrl}/etapi/${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const options = {
        method,
        signal: controller.signal,
        headers: {
          Authorization: this.token,
        },
      };

      if (body !== undefined) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
      }

      const res = await fetch(url, options);

      if (!res.ok) {
        if (res.status === 401) throw new Error("Authentication failed — check TRILIUM_ETAPI_TOKEN");
        if (res.status === 404) throw new Error(`Not found: ${path}`);
        const errText = await res.text().catch(() => "");
        throw new Error(`ETAPI error ${res.status}: ${errText || res.statusText}`);
      }

      if (res.status === 204) return null;

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        return await res.json();
      }

      // Return raw text for non-JSON responses (note content, exports)
      return await res.text();
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`TriliumNext request timed out after 10s: ${path}`);
      }
      if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
        throw new Error(`Cannot reach TriliumNext at ${this.baseUrl} — is the server running?`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** GET convenience method */
  get(path) {
    return this.request("GET", path);
  }

  /** POST convenience method */
  post(path, body) {
    return this.request("POST", path, body);
  }

  /** PUT convenience method */
  put(path, body) {
    return this.request("PUT", path, body);
  }

  /** PATCH convenience method */
  patch(path, body) {
    return this.request("PATCH", path, body);
  }

  /** DELETE convenience method */
  delete(path) {
    return this.request("DELETE", path);
  }
}
