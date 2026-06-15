/**
 * Capability-id → plain-language label, used by Fix-it cards AND (bonus) the
 * remote-exposure settings panel. Unknown ids fall back to the catalog's human
 * name (an addon's manifest `name`), then the raw id.
 */
const FRIENDLY_NAMES = {
  "funkwhale": "Music",
  "media": "News & Podcasts",
  "crow-memory": "Memory",
  "crow-blog": "Blog",
  "crow-projects": "Projects",
  "crow-sharing": "Sharing & Messages",
  "crow-storage": "Files",
};

export function resolveFriendlyName(capabilityId, catalogName) {
  if (capabilityId && FRIENDLY_NAMES[capabilityId]) return FRIENDLY_NAMES[capabilityId];
  if (catalogName && String(catalogName).trim()) return String(catalogName);
  if (capabilityId) return String(capabilityId);
  return "this feature";
}

export { FRIENDLY_NAMES };
