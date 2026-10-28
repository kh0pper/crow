/**
 * Page text extraction for fetch-before-cite. Parsing untrusted HTML (linkedom + Readability) can
 * be slow or memory-hungry, so the main thread runs it in a worker with a timeout and
 * resourceLimits (extractInWorker). The pure `extractReadable` is exported so tests and the quote
 * matcher can use it directly; the worker side starts only when this file is loaded AS a worker
 * started by extractInWorker (workerData.crowFetchPageWorker), never on a plain import.
 */
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

/** Collapse whitespace within each paragraph (blank-line separated); keep paragraph breaks. */
function collapse(text) {
  return String(text || "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** @returns {{readable: string, body: string}} */
export function extractReadable(html, url) {
  const { document } = parseHTML(String(html));
  try {
    if (url && !document.querySelector("base")) {
      const base = document.createElement("base");
      base.setAttribute("href", url);
      (document.head || document.documentElement).appendChild(base);
    }
  } catch { /* base is best effort */ }
  const body = collapse(document.body ? document.body.textContent : document.documentElement?.textContent);
  let readable = "";
  try {
    const article = new Readability(document.cloneNode(true)).parse();
    readable = collapse(article?.textContent ? article.textContent.trim() : "");
  } catch { /* fall back to body below */ }
  return { readable: readable || body, body };
}

/**
 * Run extractReadable in a worker. Resolves {readable, body} or {error: "extract_timeout" |
 * "extract_failed"}; never rejects. The worker is terminated on timeout.
 */
export function extractInWorker(html, url, { timeoutMs = 10000, workerUrl = new URL(import.meta.url) } = {}) {
  return new Promise((resolve) => {
    let worker;
    let done = false;
    let timer;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (worker) worker.terminate().catch(() => {});
      resolve(value);
    };
    try {
      worker = new Worker(workerUrl, {
        workerData: { crowFetchPageWorker: true, html, url },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 },
      });
    } catch {
      return resolve({ error: "extract_failed" });
    }
    timer = setTimeout(() => finish({ error: "extract_timeout" }), timeoutMs);
    worker.once("message", (m) => finish(m && typeof m.readable === "string" ? { readable: m.readable, body: m.body } : { error: "extract_failed" }));
    worker.once("error", () => finish({ error: "extract_failed" }));
    worker.once("exit", () => finish({ error: "extract_failed" }));
  });
}

if (!isMainThread && workerData?.crowFetchPageWorker) {
  try {
    parentPort.postMessage(extractReadable(workerData.html, workerData.url));
  } catch {
    parentPort.postMessage({ error: "extract_failed" });
  }
}
