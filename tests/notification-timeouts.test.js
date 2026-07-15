/**
 * G-F2-1 — sender-level notification timeouts (2c follow-up pool, spec §F2 C2a).
 *
 * The 2c incident class: an apply-path notification fan-out awaiting a
 * network send with no bound wedges boot or the live apply loop. These
 * tests point each REAL sender at a hung local socket (a TCP server that
 * accepts connections and never writes a byte) and assert the send
 * settles (resolves OR rejects) within a short deadline.
 *
 * RED against pre-C2a code: all three senders hang past the deadline
 * (fetch with no AbortController; webpush.sendNotification with no
 * timeout option — its TLS handshake against the raw socket never
 * completes and node applies no default socket timeout).
 *
 * Cap injection: the senders read CROW_PUSH_SEND_TIMEOUT_MS at call time
 * (default 10000 ms); the tests set it to 500 ms for speed. The email
 * sender hardcodes its Resend URL (no injection surface), so its test
 * redirects that ONE URL at the global-fetch boundary to the hung server,
 * passing every option (including the abort signal) through to the real
 * fetch — the sender's own code path runs unmodified, and nothing escapes
 * to the real network.
 *
 * No DB needed: web-push's sendPushToAll takes db as a parameter — a
 * stub recording execute() calls is the real injection surface.
 */

import { test, before, after } from "node:test";
import assert from "node:assert";
import net from "node:net";
import crypto from "node:crypto";

const CAP_MS = 500; // injected sender cap (test speed)
const DEADLINE_MS = 3000; // must settle well before this with the cap; hangs without it

let server;
let port;
const liveSockets = new Set();

before(async () => {
  // Hung upstream: accepts TCP connections, never responds. Works for
  // both plain-HTTP fetch (request sent, response never arrives) and
  // web-push's https.request (TLS handshake never answered).
  server = net.createServer((socket) => {
    liveSockets.add(socket);
    socket.on("close", () => liveSockets.delete(socket));
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  for (const socket of liveSockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
});

/** Race a sender against a wall clock. "settled" = resolved or rejected in time. */
function settleWithin(promise, ms) {
  let timer;
  const wall = new Promise((resolve) => {
    timer = setTimeout(() => resolve("hung"), ms);
  });
  return Promise.race([
    promise.then(
      () => "settled",
      () => "settled"
    ),
    wall,
  ]).finally(() => clearTimeout(timer));
}

/** Set env vars for the duration of fn, restoring previous values after. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("ntfy sender settles within the cap against a hung upstream", async () => {
  await withEnv(
    {
      NTFY_TOPIC: "timeout-test",
      NTFY_HOST: "127.0.0.1",
      NTFY_PORT: String(port),
      NTFY_AUTH_TOKEN: undefined,
      CROW_PUSH_SEND_TIMEOUT_MS: String(CAP_MS),
    },
    async () => {
      const { sendNtfyNotification } = await import(
        "../servers/gateway/push/ntfy.js"
      );
      const outcome = await settleWithin(
        sendNtfyNotification({ title: "hang test", body: "hang" }),
        DEADLINE_MS
      );
      assert.strictEqual(
        outcome,
        "settled",
        `ntfy send must settle within ${DEADLINE_MS}ms when the upstream hangs (cap ${CAP_MS}ms)`
      );
    }
  );
});

test("email sender settles within the cap against a hung upstream", async () => {
  await withEnv(
    {
      RESEND_API_KEY: "re_test_key",
      MPA_EMAIL_FROM: "crow@test.invalid",
      MPA_EMAIL_TO: "kevin@test.invalid",
      NTFY_CLICK_BASE_URL: undefined,
      CROW_GATEWAY_URL: undefined,
      CROW_PUSH_SEND_TIMEOUT_MS: String(CAP_MS),
    },
    async () => {
      const { sendEmailNotification } = await import(
        "../servers/gateway/push/email.js"
      );
      // The sender hardcodes https://api.resend.com/emails. Redirect that
      // one URL to the hung server at the fetch boundary; every option —
      // including the sender's abort signal — flows to the real fetch.
      const realFetch = globalThis.fetch;
      globalThis.fetch = (url, opts) => {
        if (String(url).startsWith("https://api.resend.com/")) {
          return realFetch(`http://127.0.0.1:${port}/emails`, opts);
        }
        return realFetch(url, opts);
      };
      try {
        // priority=high passes the shouldEmail predicate.
        const outcome = await settleWithin(
          sendEmailNotification({ title: "hang test", body: "hang", priority: "high" }),
          DEADLINE_MS
        );
        assert.strictEqual(
          outcome,
          "settled",
          `email send must settle within ${DEADLINE_MS}ms when the upstream hangs (cap ${CAP_MS}ms)`
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    }
  );
});

test("web-push sendPushToAll settles within the cap against a hung endpoint", async () => {
  const webpush = (await import("web-push")).default;
  const vapid = webpush.generateVAPIDKeys();

  // Real client-side subscription keys: uncompressed P-256 point + 16-byte
  // auth secret, base64url — webpush encrypts the payload against these
  // before dialing, so they must be structurally valid.
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const p256dh = ecdh.getPublicKey().toString("base64url");
  const auth = crypto.randomBytes(16).toString("base64url");

  await withEnv(
    {
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_EMAIL: "mailto:test@test.invalid",
      CROW_PUSH_SEND_TIMEOUT_MS: String(CAP_MS),
    },
    async () => {
      const { initWebPush, sendPushToAll } = await import(
        "../servers/gateway/push/web-push.js"
      );
      initWebPush();

      const executed = [];
      const db = {
        async execute(q) {
          const sql = typeof q === "string" ? q : q.sql;
          executed.push(sql);
          if (sql.startsWith("SELECT")) {
            return {
              rows: [
                {
                  endpoint: `https://127.0.0.1:${port}/push/hung`,
                  keys_json: JSON.stringify({ p256dh, auth }),
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const outcome = await settleWithin(
        sendPushToAll(db, { title: "hang test", body: "hang" }),
        DEADLINE_MS
      );
      assert.strictEqual(
        outcome,
        "settled",
        `web-push fan-out must settle within ${DEADLINE_MS}ms when the endpoint hangs (cap ${CAP_MS}ms)`
      );
      // A timed-out send is NOT a 410/404 — the subscription must survive.
      assert.ok(
        !executed.some((sql) => sql.startsWith("DELETE")),
        "timeout must not prune the subscription"
      );
    }
  );
});
