/**
 * The research-eval fixture world: one case's canned pages and web-search results, served
 * through the real crow-projects research tools in place of the network.
 *
 * fixtureSeams(caseDef) builds the two seams createProjectServer takes (fetchPage, webSearch).
 * A canned page goes through the real extraction (pageFromResponse), so a fixture fetch returns
 * exactly what a live fetch of the same bytes would. createFixtureServer wires the seams in and
 * refuses a missing one, because createProjectServer otherwise falls back to the real fetch and
 * the real search without a word.
 *
 * This module statically imports the server stack. Only fixture-server.mjs's main block loads
 * it, and only after the start guard (fixture-guard.mjs) has passed.
 */
import { failedRequest, pageFromResponse } from "../../servers/shared/fetch-page.js";
import { createProjectServer, dedupeKey } from "../../servers/research/server.js";

const FETCH_MODES = new Set(["ok", "403", "timeout"]);

/** What an off-set URL returns: a failed fetch, never a network request. */
const notInSet = () => ({ ok: false, fetch_status: "failed", reason: "not in fixture set", final_url: null, http_status: null });

/**
 * @param {object} caseDef a case (`pages`, `search`; see cases/)
 * @param {{onFetch?: (entry: {url: string, in_set: boolean, status: string}) => void}} [options]
 *   onFetch: called with each fetch-log entry as it is appended
 * @returns {{fetchPage: (url: string) => Promise<object>, webSearch: (q: {query: string, count?: number}) => Promise<object>, fetchLog: Array<{url: string, in_set: boolean, status: "ok"|"403"|"timeout"|"not_in_set"}>}}
 */
export function fixtureSeams(caseDef, { onFetch } = {}) {
  const pages = new Map();
  for (const [url, page] of Object.entries(caseDef?.pages || {})) {
    if (!FETCH_MODES.has(page?.fetch)) throw new Error(`fixture page ${url}: fetch must be ok, 403 or timeout`);
    if (page.fetch === "ok" && (typeof page.content_type !== "string" || typeof page.html !== "string")) {
      throw new Error(`fixture page ${url}: an ok page needs content_type and html`);
    }
    pages.set(dedupeKey(url), page);
  }
  const search = caseDef?.search || {};
  // The "default" key is the fallback list, never a pattern.
  const patterns = Object.entries(search).filter(([k]) => k !== "default").map(([k, list]) => [new RegExp(k, "i"), list]);

  const fetchLog = [];
  const log = (entry) => {
    fetchLog.push(entry);
    if (onFetch) onFetch(entry);
  };

  async function fetchPage(url) {
    const page = pages.get(dedupeKey(url));
    if (!page) {
      log({ url, in_set: false, status: "not_in_set" });
      return notInSet();
    }
    log({ url, in_set: true, status: page.fetch });
    if (page.fetch === "timeout") return failedRequest({ code: "ETIMEDOUT" });
    return pageFromResponse({
      final_url: url,
      http_status: page.fetch === "ok" ? 200 : 403,
      content_type: page.content_type,
      charset: "utf-8",
      buffer: Buffer.from(page.html ?? ""),
    });
  }

  async function webSearch({ query, count = 5 } = {}) {
    const hit = patterns.find(([re]) => re.test(String(query ?? "")));
    const list = hit ? hit[1] : (search.default || []);
    const results = list.slice(0, count).map((r) => ({ title: r.title, url: r.url, description: r.description }));
    // An empty list reads as the real search's "no results", not as zero results.
    if (results.length === 0) return { ok: false, reason: "no_results" };
    return { ok: true, results };
  }

  return { fetchPage, webSearch, fetchLog };
}

/**
 * The real research server for one case, with the fixture seams in place of the network.
 * @param {string} dbPath the scratch instance's crow.db
 * @param {object} caseDef
 * @param {{actor?: object, instructions?: string, onFetch?: Function, seams?: {fetchPage: Function, webSearch: Function}}} [options]
 */
export function createFixtureServer(dbPath, caseDef, { actor, instructions, onFetch, seams = fixtureSeams(caseDef, { onFetch }) } = {}) {
  // Checked before the server (and its database) is created: a missing seam would quietly
  // become the real fetch or the real search.
  if (typeof seams?.fetchPage !== "function" || typeof seams?.webSearch !== "function") {
    throw new Error("createFixtureServer: seams.fetchPage and seams.webSearch must both be functions");
  }
  return createProjectServer(dbPath, { actor, instructions, fetchPage: seams.fetchPage, webSearch: seams.webSearch });
}
