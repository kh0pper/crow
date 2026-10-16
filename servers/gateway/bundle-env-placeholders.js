/**
 * Placeholder values (queue item 30, fix C). A bundle's .env.example documents its keys
 * with example values ("/path/to/media", "gts.example.com", "change-me"). Copied as the
 * real .env they reached the app: a fake media mount Docker created as root, a fake
 * domain, and an encryption key published in this public repo. And "Finish setup"
 * counted them as filled.
 *
 * isPlaceholderValue() recognises them by shape, plus the SHA-256 of example values that
 * were once published in this repo (so a live .env still holding one is flagged even
 * though the example file no longer carries it). The values themselves are not kept here.
 */
import { createHash } from "node:crypto";

const PATTERNS = [
  /\/path\/to(?:\/|$)/i,
  /\byour-?user\b/i,
  /(?:^|[^a-z])your[-_]/i,
  /(?:^|[.@/:])example\.(?:com|org|net)\b/i,
  /\bchange[-_ ]?me\b/i,
  /\breplace[-_ ]?me\b/i,
  /^<[^>]*>$/,
  /\bxxx+\b/i,
  /\bplaceholder\b/i,
];

// SHA-256 of example secret values once published in bundles/*/.env.example.
const PUBLISHED = new Set([
  "113e3beef46e2a2ab77b0c3ea62ef37d823b82eab4f713a44af32bcdd2655365", // tax CROW_TAX_ENCRYPTION_KEY
  "057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86", // browser VNC / nextcloud DB example
  "d014d8b6286a673353a61a63d55ca5e449103aad4153d4b99796fe89fe93c7d3", // coturn TURN_SECRET example
  "caced0266d7c16e33b0e1ffba522a0c614db64334761f8374f1ba46990dda696", // nextcloud DB root example
]);

export function isPublishedExampleValue(v) {
  if (typeof v !== "string" || v === "") return false;
  return PUBLISHED.has(createHash("sha256").update(v).digest("hex"));
}

export function isPlaceholderValue(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (s === "") return false;
  return PATTERNS.some((re) => re.test(s)) || isPublishedExampleValue(s);
}
