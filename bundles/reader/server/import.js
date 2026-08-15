/**
 * Reader — import pipeline. All four source paths converge here:
 * store original, extract, write sections, set status.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { resolveDataDir } from "./db.js";
import { runExtraction } from "./extract.js";

const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = "Mozilla/5.0 (compatible; Crow-Reader/1.0; +https://github.com/kh0pper/crow)";

const MIME_BY_EXT = {
  ".pdf": "application/pdf", ".html": "text/html", ".htm": "text/html",
  ".txt": "text/plain", ".md": "text/markdown",
};

export function readerDataDir(config) {
  const base = join(config.CROW_DATA_DIR || resolveDataDir(), "reader");
  mkdirSync(join(base, "originals"), { recursive: true });
  mkdirSync(join(base, "archives"), { recursive: true });
  return base;
}

export function splitIntoParagraphsJs(text) {
  return String(text || "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

/** Sentence-boundary split of an over-long paragraph (mirrors the Python cap). */
export function splitLongParagraphJs(text, maxWords = 500) {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text];
  const out = [];
  let current = [];
  let count = 0;
  for (const s of sentences) {
    const n = s.split(/\s+/).filter(Boolean).length;
    if (count + n > maxWords && current.length) {
      out.push(current.join("").trim());
      current = [];
      count = 0;
    }
    current.push(s);
    count += n;
  }
  if (current.length) out.push(current.join("").trim());
  return out;
}

function textToSections(raw) {
  const paras = [];
  for (const p of splitIntoParagraphsJs(raw)) paras.push(...splitLongParagraphJs(p));
  return [{ title: null, paragraphs: paras }];
}

/**
 * SSRF guard: block loopback/private/link-local hosts unless configured open.
 * Accepted risk: DNS rebinding TOCTOU (this lookup and the fetch resolve
 * independently); fine for a single-user authenticated dashboard.
 * Exported for direct unit testing.
 */
function isPrivateAddress(address) {
  return (
    /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) ||
    // "::" (unspecified) connects to localhost on Linux; URL parsing
    // canonicalizes every all-zero IPv6 literal to this exact form.
    address === "::1" || address === "::" ||
    /^f[cd]/i.test(address) || /^fe80/i.test(address)
  );
}

/**
 * Unwrap an IPv4-mapped IPv6 address (::ffff:a.b.c.d) to its embedded IPv4
 * tail. Two textual forms have to be handled: DNS lookups typically report
 * the dotted-decimal form (::ffff:127.0.0.1), but the WHATWG URL parser
 * canonicalizes bracketed IPv6 literals to pure hex groups
 * (::ffff:7f00:1) before assertPublicHost ever sees the hostname. Returns
 * null when the address isn't an IPv4-mapped IPv6 address.
 */
function unwrapIPv4MappedIPv6(address) {
  const lower = address.toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join(".");
  }
  return null;
}

export async function assertPublicHost(url, config) {
  if (config.READER_ALLOW_PRIVATE_URLS === "1") return;
  const { lookup } = await import("node:dns/promises");
  const { isIP } = await import("node:net");
  const host = new URL(url).hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const { address } of addrs) {
    // IPv4-mapped IPv6 embeds a routable-looking IPv4 tail that the
    // bare-address checks above never match; unwrap and re-check it.
    const mapped = unwrapIPv4MappedIPv6(address);
    if (isPrivateAddress(address) || (mapped && isPrivateAddress(mapped))) {
      throw new Error(`URL resolves to a private address (${address}); set READER_ALLOW_PRIVATE_URLS=1 to permit`);
    }
  }
}

const MAX_REDIRECTS = 5;

async function fetchUrl(url, config, fetchImpl) {
  const capBytes = Number(config.READER_MAX_UPLOAD_MB || 50) * 1024 * 1024;
  const doFetch = fetchImpl || fetch;

  // Follow redirects MANUALLY so every hop passes the SSRF guard; a
  // public URL that 302s to a private address must not slip through.
  // Injected fetchImpl (tests) skips the DNS guard but keeps the loop.
  let current = url;
  let res = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`unsupported URL scheme: ${parsed.protocol}`);
    }
    if (!fetchImpl) await assertPublicHost(current, config);
    res = await doFetch(current, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html, application/pdf, */*" },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400) {
      if (!location) throw new Error(`redirect without location fetching ${current}`);
      current = new URL(location, current).href;
      continue;
    }
    break;
  }
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`too many redirects fetching ${url}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > capBytes) throw new Error(`response exceeds ${capBytes} byte cap`);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > capBytes) throw new Error(`response exceeds ${capBytes} byte cap`);
    chunks.push(chunk);
  }
  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
  return { contentType, buffer: Buffer.concat(chunks) };
}

/** Normalize a comma-separated tag string: trim, drop empties, lowercase. */
export function normalizeTags(tags) {
  if (!tags) return null;
  const list = String(tags).split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  return list.length ? list.join(",") : null;
}

function readableFromHtml(html, url) {
  const { document } = parseHTML(html);
  const title = document.querySelector("title")?.textContent?.trim() || null;
  const article = new Readability(document).parse();
  const text = article?.textContent?.trim() || "";
  return { title: article?.title || title, text };
}

async function writeSections(db, docId, sections) {
  await db.execute({ sql: "DELETE FROM reader_sections WHERE document_id = ?", args: [docId] });
  let n = 1;
  for (const s of sections) {
    await db.execute({
      sql: `INSERT INTO reader_sections (document_id, section_number, title, paragraphs_json)
            VALUES (?, ?, ?, ?)`,
      args: [docId, n++, s.title, JSON.stringify(s.paragraphs)],
    });
  }
}

export async function ingestDocument(db, config, input, deps = {}) {
  const extractImpl = deps.extractImpl || ((p, o) => runExtraction(p, config, o));
  const base = readerDataDir(config);

  // 1. Insert the row first so the file name carries the id.
  const insert = await db.execute({
    sql: `INSERT INTO reader_documents (title, source_type, source_ref, tags, extraction_status)
          VALUES (?, ?, ?, ?, 'pending')`,
    args: [input.title || input.filename || input.url || "Untitled",
           input.sourceType, input.url || input.filename || null, normalizeTags(input.tags)],
  });
  const id = Number(insert.lastInsertRowid);

  let sections = null;
  let status = "failed";
  let diagnostics = null;
  let originalPath = null;
  let archivedHtmlPath = null;
  let mime = null;
  let resolvedTitle = input.title || null;

  try {
    let buffer = input.buffer || null;
    let ext = input.filename ? extname(input.filename).toLowerCase() : null;

    if (input.sourceType === "url") {
      const fetched = await fetchUrl(input.url, config, deps.fetchImpl);
      buffer = fetched.buffer;
      ext = fetched.contentType === "application/pdf" ? ".pdf" : ".html";
    }
    if (!buffer) throw new Error("no content to ingest");
    if (!ext || !(ext in MIME_BY_EXT)) {
      throw new Error(`unsupported file type: ${ext || "unknown"}`);
    }
    mime = MIME_BY_EXT[ext];

    originalPath = join(base, "originals", `${id}${ext}`);
    writeFileSync(originalPath, buffer);

    if (ext === ".pdf") {
      const result = await extractImpl(originalPath, { ocr: !!input.ocr });
      if (result.ok) {
        sections = result.sections;
        diagnostics = result.diagnostics;
        const empty = sections.every((s) => s.paragraphs.length === 0);
        status = empty ? "partial" : "ok";
      } else {
        diagnostics = { error: result.error };
        status = "failed";
      }
    } else if (ext === ".html" || ext === ".htm") {
      const html = buffer.toString("utf8");
      archivedHtmlPath = join(base, "archives", `${id}.html`);
      writeFileSync(archivedHtmlPath, html);
      const { title, text } = readableFromHtml(html, input.url);
      if (!resolvedTitle && title) resolvedTitle = title;
      sections = textToSections(text);
      status = text ? "ok" : "partial";
    } else { // .txt / .md
      sections = textToSections(buffer.toString("utf8"));
      status = "ok";
    }

    if (sections) await writeSections(db, id, sections);
  } catch (err) {
    diagnostics = { error: err.message };
    status = "failed";
  }

  await db.execute({
    sql: `UPDATE reader_documents SET title = COALESCE(?, title), original_path = ?,
            original_mime = ?, archived_html_path = ?, extraction_status = ?,
            extraction_diagnostics = ?, updated_at = datetime('now')
          WHERE id = ?`,
    args: [resolvedTitle, originalPath, mime, archivedHtmlPath, status,
           diagnostics ? JSON.stringify(diagnostics) : null, id],
  });

  return { id, extraction_status: status };
}
