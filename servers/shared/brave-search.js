/**
 * The one Brave Search caller (the wm server and crow_web_search both use it).
 * Results are search snippets, not pages: nothing here opens a result URL.
 */

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/** Strip tags and decode the entities Brave puts in titles and descriptions. */
export function stripSnippetHtml(s) {
  return String(s ?? "").replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'").replace(/&#x2F;/g, "/").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * @param {{query: string, count?: number, apiKey?: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{ok: true, results: Array<{title: string, url: string, description: string}>} | {ok: false, reason: string}>}
 *   reason: "not_configured", "no_results", or a "Search failed: ..." message. Never throws.
 */
export async function braveSearch({ query, count = 5, apiKey = process.env.BRAVE_API_KEY || "", fetchImpl = fetch } = {}) {
  if (!apiKey) return { ok: false, reason: "not_configured" };
  const n = Math.max(1, Math.min(10, Math.trunc(Number(count)) || 5));
  try {
    const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${n}`;
    const res = await fetchImpl(url, {
      headers: { "Accept": "application/json", "X-Subscription-Token": apiKey },
    });
    if (!res.ok) return { ok: false, reason: `Search failed: ${res.status}` };
    const data = await res.json();
    const results = (data.web?.results || []).slice(0, n).map((r) => ({
      title: stripSnippetHtml(r.title || "Untitled"),
      url: r.url || "",
      description: stripSnippetHtml(r.description || ""),
    }));
    if (results.length === 0) return { ok: false, reason: "no_results" };
    return { ok: true, results };
  } catch (e) {
    return { ok: false, reason: `Search failed: ${e.message}` };
  }
}
