import { test } from "node:test";
import assert from "node:assert/strict";
import * as i18n from "../servers/gateway/dashboard/shared/i18n.js";

const CONNECT_KEYS = [
  "connect.title", "connect.intro",
  "connect.localStdioHeading", "connect.remoteHttpHeading",
  "connect.stdioNote", "connect.oauthNote",
  "connect.cc.stdioLead", "connect.cc.remoteLead",
  "connect.cursor.lead", "connect.cline.lead",
  "connect.gemini.lead", "connect.desktop.lead",
  "connect.cloud.warning",
  "connect.moreHeading", "connect.openConnections",
  "connect.openWizard", "connect.settingsPointer",
];

test("every connect.* key has a non-empty en AND es value", () => {
  for (const k of CONNECT_KEYS) {
    const entry = i18n.translations[k];
    assert.ok(entry, `missing translations entry for ${k}`);
    assert.ok(entry.en && entry.en.trim(), `missing/empty en value for ${k}`);
    assert.ok(entry.es && entry.es.trim(), `missing/empty es value for ${k}`);
  }
});
