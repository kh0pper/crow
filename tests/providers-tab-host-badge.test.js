import { test } from "node:test";
import assert from "node:assert/strict";
import { hostBadge, engineBadge, statusDot } from "../servers/gateway/dashboard/settings/sections/llm/providers-tab.js";

const ctx = {
  ownAddrs: new Set(["127.0.0.1", "::1", "localhost", "100.118.41.122"]),
  ownInstanceId: "0867ac2809dedd885ba7769b21966f8e",
  instanceNames: new Map(),
};

test("hostBadge renders the honest label and escapes it", () => {
  assert.match(hostBadge({ host: "cloud", baseUrl: "http://10.0.0.126:8030/v1", provider_type: "openai-compat" }, ctx), />network</);
  assert.match(hostBadge({ host: "cloud", baseUrl: "https://api.together.xyz/v1", provider_type: "openai-compat" }, ctx), />cloud · openai-compat</);
  assert.match(hostBadge({ host: "local", baseUrl: "http://100.118.41.122:8003/v1" }, ctx), />this machine</);
  assert.match(hostBadge({ host: "<b>x", baseUrl: "http://10.0.0.1/v1" }, ctx), /&lt;b&gt;x/);
});

// --- external engines (spec 2026-09-23 external-engine-provider §2.4) -------

const ENGINE = { managed: "external", host: "raven", label: "halogen" };
const RAVEN = "http://10.0.0.126:8030/v1";
const row = (extra = {}) => ({ id: "raven-flash-next", baseUrl: RAVEN, host: "cloud", disabled: false, gpuPolicy: { engine: ENGINE }, ...extra });

test("engineBadge: 'external · <host>' for a marked row (en + es), nothing for an unmarked one", () => {
  assert.equal(engineBadge({ gpuPolicy: null }), "");
  assert.equal(engineBadge({ gpuPolicy: { runtime: "native" } }), "");
  assert.match(engineBadge(row()), />external · raven</);
  assert.match(engineBadge(row(), "es"), />externo · raven</);
  assert.match(engineBadge(row()), /title="halogen"/);
});

test("engineBadge escapes free-text host and label replicated from a peer", () => {
  const evil = engineBadge(row({ gpuPolicy: { engine: { managed: "external", host: "<img src=x onerror=alert(1)>", label: "\"><script>" } } }));
  assert.doesNotMatch(evil, /<img/);
  assert.doesNotMatch(evil, /<script>/);
  assert.match(evil, /&lt;img/);
  assert.match(evil, /&quot;&gt;&lt;script&gt;/);
});

test("statusDot: an external row reflects the external health map — up / down / not probed yet", () => {
  const unprobed = statusDot(row(), { external: {} });
  assert.match(unprobed, /not probed yet/);
  assert.match(unprobed, /var\(--crow-text-muted\)/);

  const up = statusDot(row(), { external: { "raven-flash-next": { ready: true, baseUrl: RAVEN } } });
  assert.match(up, /var\(--crow-success\)/);
  assert.match(up, /external engine reachable from this instance/);

  const down = statusDot(row(), { external: { "raven-flash-next": { ready: false, baseUrl: RAVEN } } });
  assert.match(down, /var\(--crow-error\)/);
  assert.match(down, /not reachable from this instance/);

  const es = statusDot(row(), { external: {}, lang: "es" });
  assert.match(es, /aún sin sondear/);
});

test("statusDot: health recorded for an OLD base_url reads as not probed yet (row was repointed)", () => {
  const stale = statusDot(row(), { external: { "raven-flash-next": { ready: true, baseUrl: "http://10.0.0.127:8030/v1" } } });
  assert.match(stale, /not probed yet/);
});

test("statusDot: disabled and unmarked rows keep today's dots regardless of the map", () => {
  assert.match(statusDot(row({ disabled: true }), { external: { "raven-flash-next": { ready: true, baseUrl: RAVEN } } }), /disabled \(soft-delete\)/);
  const plain = statusDot({ id: "cloud-openai", baseUrl: "https://api.openai.com/v1", disabled: false, gpuPolicy: null }, { external: {} });
  assert.match(plain, /title="enabled"/);
  assert.match(plain, /var\(--crow-success\)/);
});

test("render: a marked listProvidersAll row gets the badge and the not-probed dot (stub db, empty health map)", async () => {
  const { default: tab } = await import("../servers/gateway/dashboard/settings/sections/llm/providers-tab.js");
  const db = {
    execute: async (q) => {
      const sql = typeof q === "string" ? q : q.sql;
      if (sql.includes("FROM providers")) {
        return { rows: [{
          id: "raven-flash-next", base_url: RAVEN, api_key: null, host: "cloud", bundle_id: null,
          provider_type: "openai-compat", description: null, models: "[]",
          gpu_policy: JSON.stringify({ engine: ENGINE }), disabled: 0,
        }] };
      }
      return { rows: [] };
    },
  };
  const html = await tab.render({ db, lang: "en" });
  assert.match(html, />external · raven</);
  assert.match(html, /external engine not probed yet/);
});
