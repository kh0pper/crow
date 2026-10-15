/**
 * Blog collections config — the optional, owner-edited file that turns on the
 * public /blog/research page and the case-study chapter nav.
 *
 * Location: $CROW_BLOG_COLLECTIONS_CONFIG, else <CROW_HOME>/blog/collections.json.
 * A missing file is the default install state: the feature is off and nothing
 * is logged. Any other failure (unreadable, not JSON, schema violation) also
 * turns the feature off, never throws, and warns once per (mtime, error code)
 * with the path and issue codes only — never field values, because the route
 * that reads this is reachable from the public internet and the log should not
 * become a side channel for the file's contents.
 *
 * This module only ever READS the file. No MCP tool, dashboard route or setting
 * writes it (tests/blog-no-personal-research.test.js enforces that), which is
 * what lets `featured.blurbHtml` carry a small amount of (sanitized) HTML.
 */
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveCrowHome } from "../../shared/crow-home.js";

const DISABLED = Object.freeze({ enabled: false });

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE_RE = /^[A-Za-z0-9._-]{1,128}$/;

function isSafeDocBase(base) {
  if (base.startsWith("/blog/")) {
    return !base.includes("..") && !base.includes("//") && !base.includes("\\") && !/\s/.test(base);
  }
  try {
    const u = new URL(base);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const docLinksSchema = z.object({
  base: z.string().max(300).refine(isSafeDocBase, { message: "docLinks.base must be a /blog/ path or an http(s) URL" }),
  rules: z.array(z.object({
    slugContains: z.string().min(1).max(64),
    file: z.string().regex(FILE_RE),
  }).strict()).max(8).default([]),
  defaultFile: z.string().regex(FILE_RE),
}).strict();

const caseStudiesSection = z.object({
  kind: z.literal("case-studies"),
  heading: z.string().min(1).max(120),
  projectId: z.number().int().positive(),
  emptyText: z.string().max(200).optional(),
}).strict();

const tagSection = z.object({
  kind: z.literal("tag"),
  heading: z.string().min(1).max(120),
  tag: z.string().regex(TAG_RE),
  blurb: z.string().max(600).optional(),
  hideIfEmpty: z.boolean().default(true),
  docLinks: docLinksSchema.optional(),
}).strict();

export const collectionsConfigSchema = z.object({
  enabled: z.boolean(),
  navTitle: z.string().min(1).max(40),
  pageTitle: z.string().min(1).max(160),
  intro: z.string().max(600),
  lang: z.enum(["en", "es"]).default("en"),
  featured: z.object({
    title: z.string().min(1).max(300),
    blurbHtml: z.string().max(4000),
  }).strict().optional(),
  sections: z.array(z.discriminatedUnion("kind", [caseStudiesSection, tagSection])).max(8),
  chapterNav: z.object({
    tag: z.string().regex(TAG_RE),
    projectId: z.number().int().positive(),
    indexLabel: z.string().min(1).max(60).optional(),
  }).strict().optional(),
}).strict();

/** The config file path for this instance (read at call time). */
export function collectionsConfigPath(env = process.env) {
  return env.CROW_BLOG_COLLECTIONS_CONFIG || join(resolveCrowHome(env), "blog", "collections.json");
}

// path -> { mtimeMs, size, value }
const cache = new Map();
// `${path}|${mtimeMs}|${code}` already warned
const warned = new Set();

function warnOnce(path, mtimeMs, code, detail) {
  const key = `${path}|${mtimeMs}|${code}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn("[blog] collections config disabled", { path, ...detail });
}

/**
 * Load the collections config. Returns `{enabled:false}` when the feature is
 * off for any reason; otherwise the parsed (defaults applied) config.
 */
export function loadCollectionsConfig({ path } = {}) {
  const p = path || collectionsConfigPath();
  let st;
  try {
    st = statSync(p);
  } catch (err) {
    cache.delete(p);
    if (err?.code !== "ENOENT") warnOnce(p, 0, err?.code || "stat_error", { code: err?.code || "stat_error" });
    return DISABLED;
  }

  const hit = cache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;

  let value = DISABLED;
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    const code = err?.code || "read_error";
    warnOnce(p, st.mtimeMs, code, { code });
    cache.set(p, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    warnOnce(p, st.mtimeMs, "invalid_json", { code: "invalid_json" });
    cache.set(p, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  }

  const parsed = collectionsConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ code: i.code, path: i.path.join(".") }));
    warnOnce(p, st.mtimeMs, `schema:${issues.map((i) => i.code).join(",")}`, { issues });
  } else if (parsed.data.enabled) {
    value = parsed.data;
  }
  cache.set(p, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}
