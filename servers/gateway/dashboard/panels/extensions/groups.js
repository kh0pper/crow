/**
 * Extensions Panel — category display groups.
 *
 * The registry has 18+ fine-grained categories, which rendered as 19 filter
 * tabs and (with the old flex-nowrap tab row) inflated the page to 2555px.
 * The store UI groups them into a handful of browsable sections instead.
 * The registry is NOT changed — this is a display-side mapping, so new
 * registry categories keep working: anything unmapped lands in "More".
 */

export const DISPLAY_GROUPS = [
  { id: "ai",             labelKey: "extensions.groupAi",             categories: ["ai"] },
  { id: "media",          labelKey: "extensions.groupMedia",          categories: ["media"] },
  { id: "productivity",   labelKey: "extensions.groupProductivity",   categories: ["productivity", "education"] },
  { id: "social",         labelKey: "extensions.groupSocial",         categories: ["social", "federated-social", "federated-media", "federated-comms"] },
  { id: "infrastructure", labelKey: "extensions.groupInfrastructure", categories: ["infrastructure", "networking", "storage", "data", "automation"] },
  { id: "home-hardware",  labelKey: "extensions.groupHomeHardware",   categories: ["smart-home", "cameras", "hardware"] },
  { id: "more",           labelKey: "extensions.groupMore",           categories: ["finance", "gaming", "other"] },
];

const CATEGORY_TO_GROUP = new Map();
for (const g of DISPLAY_GROUPS) {
  for (const c of g.categories) CATEGORY_TO_GROUP.set(c, g.id);
}

/** Group id for a registry category. Unknown/missing → "more" (never dropped). */
export function groupForCategory(category) {
  if (!category) return "more";
  return CATEGORY_TO_GROUP.get(category) || "more";
}

/**
 * Bucket add-ons by display group.
 * @returns {Map<string, Array<object>>} group id → addons (input order preserved);
 *   groups with no add-ons are absent from the map.
 */
export function groupAddons(addons) {
  const out = new Map();
  for (const g of DISPLAY_GROUPS) {
    const members = addons.filter((a) => groupForCategory(a.category) === g.id);
    if (members.length > 0) out.set(g.id, members);
  }
  return out;
}
