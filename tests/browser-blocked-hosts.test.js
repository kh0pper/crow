// The bot browser never loads Alibaba Cloud storage (OSS) links or the
// routify file proxy (2026-10-29 field sighting: a Qwen-backed bot opened
// made-up routify-file-proxy links). Qwen Cloud's API hosts stay allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isBlockedUrl, BLOCKED_URL_PATTERNS, blockedResult } from "../bundles/browser/server/blocked-hosts.js";

test("routify file proxy and Alibaba OSS hosts are blocked", () => {
  for (const u of [
    "https://routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com/proxy_temp_file/production/x?Expires=1",
    "https://routify-file-proxy.example.net/a",
    "https://mybucket.oss-cn-beijing.aliyuncs.com/key",
    "http://bucket.oss-cn-hangzhou-internal.aliyuncs.com/",
    "https://bucket.oss.aliyuncs.com/x",
    "https://oss-cn-beijing.aliyuncs.com/bucket/key",
    "https://ROUTIFY-FILE-PROXY-SG.OSS-AP-SOUTHEAST-1.ALIYUNCS.COM./x",
  ]) assert.equal(isBlockedUrl(u), true, u);
});

test("Qwen Cloud API hosts, other Alibaba hosts and ordinary sites are not blocked", () => {
  for (const u of [
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
    "https://dashscope.aliyuncs.com/api/v1",
    "https://www.aliyun.com/",
    "https://www.portaransas.org/event/x/6346/",
    "https://example.com/oss-cn-beijing.aliyuncs.com",
    "not a url",
  ]) assert.equal(isBlockedUrl(u), false, u);
});

test("the in-page patterns cover the same hosts, and the refusal says why", () => {
  assert.ok(BLOCKED_URL_PATTERNS.includes("*://routify-file-proxy*"));
  assert.ok(BLOCKED_URL_PATTERNS.some((p) => p.includes(".oss-") && p.includes("aliyuncs.com")));
  const r = blockedResult("https://bucket.oss-cn-beijing.aliyuncs.com/k");
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Alibaba Cloud storage/);
});

test("navigate, the PDF fetch and the reader all check the host before loading", () => {
  const src = readFileSync(new URL("../bundles/browser/server/server.js", import.meta.url), "utf8");
  assert.match(src, /if \(isBlockedUrl\(url\)\) \{/);
  assert.match(src, /if \(isBlockedUrl\(url_or_path\)\) return blockedResult\(url_or_path\);/);
  assert.match(src, /if \(isBlockedUrl\(candidateUrl\(m\)\)\)/);
  assert.match(src, /Network\.setBlockedURLs/);
});
