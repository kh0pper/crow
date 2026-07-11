/**
 * F2 (BH-1/2) — `settings.section.unifiedDashboard` (unified-dashboard.js:18)
 * and `settings.section.sharedStorage` (shared-storage.js:62) were absent
 * from shared/i18n.js, so t() fell through to its raw-key fallback and the
 * menu label / page heading / breadcrumb rendered the literal key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

test("settings.section.unifiedDashboard and .sharedStorage resolve in en + es", () => {
  const cases = [
    ["settings.section.unifiedDashboard", "en", "Unified Dashboard"],
    ["settings.section.unifiedDashboard", "es", "Panel unificado"],
    ["settings.section.sharedStorage", "en", "Shared Storage"],
    ["settings.section.sharedStorage", "es", "Almacenamiento compartido"],
  ];
  for (const [key, lang, expected] of cases) {
    const value = t(key, lang);
    assert.notEqual(value, key, `t(${key}, ${lang}) must not fall back to the raw key`);
    assert.equal(value, expected);
  }
});
