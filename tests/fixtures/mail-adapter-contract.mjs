/**
 * The adapter contract, in one place, run by every implementation's test file: the in-memory fake
 * (Task 11) and the imapflow + nodemailer adapter (Tasks 12 and 13). One list, so a change to one
 * implementation cannot drift from the other.
 *
 * `makeAdapter(opts)` is an async factory returning `{adapter, ...seeding hooks}`. How a message gets
 * into a mailbox is the server's business, not the contract's, so seeding is deliberately not part
 * of the adapter: the factory supplies `deliver`, `expunge`, `moveIn`, `bumpUidValidity` and
 * `dropWatch` (drop the watch connection), and a step whose hook the factory does not provide is
 * skipped rather than failed. `opts` carries the one per-server setting a step needs: `omitUidNext`
 * (the server's listing omits UIDNEXT). The factory returns a ready adapter: an implementation that
 * needs a connection calls its own `connect()` before handing it over, because how and when it
 * connects is not part of the contract.
 *
 * `skip` holds method names, hook names or step names. Task 12 passes `["saveDraft", "send"]` until
 * Task 13 implements them; each step declares the methods it uses, so that is enough.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAdapter } from "../../servers/gateway/mail/adapter/interface.js";
import { MailError } from "../../servers/gateway/mail/errors.js";

/** A small RFC 822 message, CRLF, with the headers every mail server normalises. */
export function rawMessage({
  from = "alex@example.com",
  to = "sam@example.com",
  subject = "Hello",
  body = "Hello there",
  messageId = null,
} = {}) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date(Date.UTC(2026, 0, 5, 9, 30)).toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ];
  if (messageId) lines.push(`Message-ID: ${messageId}`);
  lines.push("", body, "");
  return lines.join("\r\n");
}

const STEPS = [
  {
    name: "an adapter provides every method of the contract",
    methods: [],
    hooks: [],
    async run({ adapter }) {
      assert.doesNotThrow(() => assertAdapter(adapter));
    },
  },
  {
    name: "listFolders names INBOX and the sent folder",
    methods: ["listFolders"],
    hooks: [],
    async run({ adapter }) {
      const folders = await adapter.listFolders();
      assert.ok(Array.isArray(folders) && folders.length > 0, "at least one folder is listed");
      for (const folder of folders) {
        assert.equal(typeof folder.path, "string");
        assert.equal(typeof folder.name, "string");
        assert.equal(typeof folder.delimiter, "string");
        assert.equal(typeof folder.selectable, "boolean");
        assert.ok(folder.specialUse == null || typeof folder.specialUse === "string");
      }
      assert.ok(folders.some((folder) => folder.path === "INBOX"), "INBOX is listed");
      assert.ok(folders.some((folder) => folder.specialUse === "\\Sent"), "a \\Sent folder is listed");
    },
  },
  {
    name: "list reports uidValidity, uidNext and the message shape",
    methods: ["list"],
    hooks: ["deliver"],
    async run({ adapter, deliver }) {
      await deliver("INBOX", rawMessage({ subject: "one" }));
      await deliver("INBOX", rawMessage({ subject: "two" }));
      const listing = await adapter.list("INBOX");
      assert.ok(Number.isInteger(listing.uidValidity) && listing.uidValidity > 0);
      assert.ok(Number.isInteger(listing.uidNext), "uidNext is never missing");
      const highest = Math.max(...listing.items.map((item) => item.uid));
      assert.ok(listing.uidNext > highest, "uidNext is past the newest uid");
      for (const item of listing.items) {
        assert.ok(Number.isInteger(item.uid));
        assert.ok(Array.isArray(item.flags));
        assert.equal(typeof item.internalDate, "number");
        assert.equal(typeof item.size, "number");
      }
    },
  },
  {
    name: "afterUid at the highest uid returns nothing (the n:* quirk)",
    methods: ["list"],
    hooks: ["deliver"],
    async run({ adapter, deliver }) {
      const uids = [];
      for (const subject of ["a", "b", "c"]) uids.push(await deliver("INBOX", rawMessage({ subject })));
      const highest = Math.max(...uids);
      const empty = await adapter.list("INBOX", { afterUid: highest });
      assert.deepEqual(empty.items, [], "a search from one past the end returns no message");
      const two = await adapter.list("INBOX", { afterUid: highest - 2 });
      assert.deepEqual(two.items.map((item) => item.uid), [highest - 1, highest]);
    },
  },
  {
    name: "a listing that omits UIDNEXT still yields a uidNext",
    methods: ["list"],
    hooks: ["deliver"],
    opts: { omitUidNext: true },
    async run({ adapter, deliver }) {
      await deliver("INBOX", rawMessage({ subject: "one" }));
      await deliver("INBOX", rawMessage({ subject: "two" }));
      const listing = await adapter.list("INBOX");
      assert.equal(listing.uidNext, 3, "the highest listed uid plus one");
      const filtered = await adapter.list("INBOX", { afterUid: 2 });
      assert.ok(Number.isInteger(filtered.uidNext) && filtered.uidNext >= 1,
        "a filtered listing never reports a missing uidNext");
    },
  },
  {
    name: "beforeUid with newestFirst and a limit pages down",
    methods: ["list"],
    hooks: ["deliver"],
    async run({ adapter, deliver }) {
      for (const subject of ["one", "two", "three", "four", "five"]) {
        await deliver("INBOX", rawMessage({ subject }));
      }
      const page = await adapter.list("INBOX", { beforeUid: 5, newestFirst: true, limit: 2 });
      assert.deepEqual(page.items.map((item) => item.uid), [4, 3]);
      const next = await adapter.list("INBOX", { beforeUid: 3, newestFirst: true, limit: 2 });
      assert.deepEqual(next.items.map((item) => item.uid), [2, 1]);
    },
  },
  {
    name: "fromUid returns every uid at or above it, with flags",
    methods: ["list"],
    hooks: ["deliver"],
    async run({ adapter, deliver }) {
      await deliver("INBOX", rawMessage({ subject: "one" }));
      await deliver("INBOX", rawMessage({ subject: "two" }), { flags: ["\\Seen"] });
      await deliver("INBOX", rawMessage({ subject: "three" }), { flags: [] });
      const listing = await adapter.list("INBOX", { fromUid: 2 });
      assert.deepEqual(listing.items.map((item) => item.uid), [2, 3]);
      assert.deepEqual(listing.items[0].flags, ["\\Seen"]);
      assert.deepEqual(listing.items[1].flags, []);
    },
  },
  {
    name: "sinceDate is an exact millisecond bound",
    methods: ["list"],
    hooks: ["deliver"],
    async run({ adapter, deliver }) {
      const t = Date.UTC(2026, 1, 2, 3, 4, 5);
      await deliver("INBOX", rawMessage({ subject: "old" }), { internalDate: t });
      await deliver("INBOX", rawMessage({ subject: "new" }), { internalDate: t + 1 });
      const exact = await adapter.list("INBOX", { sinceDate: t + 1 });
      assert.deepEqual(exact.items.map((item) => item.uid), [2], "one millisecond before the bound is out");
      const inclusive = await adapter.list("INBOX", { sinceDate: t });
      assert.deepEqual(inclusive.items.map((item) => item.uid), [1, 2]);
    },
  },
  {
    name: "get returns the messages it has and skips the uids it does not",
    methods: ["get", "list"],
    hooks: ["deliver"],
    async run({ adapter, deliver }) {
      const first = await deliver("INBOX", rawMessage({ subject: "fetch me", body: "the body words" }));
      const second = await deliver("INBOX", rawMessage({ subject: "and me" }));
      const got = await adapter.get("INBOX", [first, second + 40]);
      assert.equal(got.length, 1, "a uid the mailbox does not have is simply absent");
      assert.equal(got[0].uid, first);
      assert.ok(Buffer.isBuffer(got[0].raw), "raw is the message's bytes");
      assert.match(got[0].raw.toString("utf8"), /fetch me/);
      assert.ok(Array.isArray(got[0].flags));
      assert.equal(typeof got[0].internalDate, "number");
    },
  },
  {
    name: "search finds a message in one folder or across folders",
    methods: ["search"],
    hooks: ["deliver"],
    async run({ adapter, deliver }) {
      const inInbox = await deliver("INBOX", rawMessage({ subject: "wombat report" }));
      const inSent = await deliver("Sent", rawMessage({ subject: "Re: wombat report" }));
      assert.deepEqual(await adapter.search("wombat"), [
        { folderPath: "INBOX", uid: inInbox },
        { folderPath: "Sent", uid: inSent },
      ]);
      assert.deepEqual(await adapter.search("wombat", { folderPath: "Sent" }),
        [{ folderPath: "Sent", uid: inSent }]);
      assert.deepEqual(await adapter.search("no-such-token-anywhere"), []);
      assert.equal((await adapter.search("wombat", { limit: 1 })).length, 1);
    },
  },
  {
    name: "saveDraft stores the raw text in a drafts folder",
    methods: ["saveDraft", "get"],
    hooks: [],
    async run({ adapter }) {
      const raw = rawMessage({ subject: "draft subject", body: "draft body marker" });
      const saved = await adapter.saveDraft(raw);
      assert.equal(typeof saved.folderPath, "string");
      assert.ok(saved.uid == null || Number.isInteger(saved.uid), "uid is a uid or null");
      if (saved.uid == null) return; // a server without UIDPLUS cannot name the appended message
      const [stored] = await adapter.get(saved.folderPath, [saved.uid]);
      assert.ok(stored, "the draft is fetchable at the uid it was saved as");
      assert.match(stored.raw.toString("utf8"), /draft body marker/);
      assert.ok(stored.flags.includes("\\Draft"), "it is marked as a draft");
    },
  },
  {
    name: "send returns a messageId and the addresses it accepted",
    methods: ["send"],
    hooks: [],
    async run({ adapter }) {
      const result = await adapter.send({
        from: { name: "Alex", address: "alex@example.com" },
        to: [{ address: "sam@example.com" }],
        cc: [{ name: "Kim", address: "kim@example.com" }],
        subject: "Hello from Crow",
        text: "A plain body.",
      });
      assert.match(result.messageId, /^<[^<>\s@]+@[^<>\s@]+>$/);
      assert.deepEqual([...result.accepted].sort(), ["kim@example.com", "sam@example.com"]);
      assert.deepEqual(result.rejected, []);
    },
  },
  {
    name: "watch reports a change in a watched folder and stop() ends it",
    methods: ["watch"],
    hooks: ["deliver"],
    async run({ adapter, deliver }) {
      const changes = [];
      const errors = [];
      const watcher = await adapter.watch(["INBOX"], {
        onChange: (event) => changes.push(event),
        onError: (err) => errors.push(err),
      });
      assert.equal(typeof watcher.stop, "function");
      await deliver("INBOX", rawMessage({ subject: "arrived" }));
      assert.equal(changes.length, 1, "a delivery in a watched folder reports a change");
      assert.equal(changes[0].folderPath, "INBOX");
      await deliver("Sent", rawMessage({ subject: "not watched" }));
      assert.equal(changes.length, 1, "a folder that is not watched reports nothing");
      watcher.stop();
      await deliver("INBOX", rawMessage({ subject: "after stop" }));
      assert.equal(changes.length, 1, "stop() ends the watcher");
      assert.deepEqual(errors, []);
    },
  },
  {
    name: "a lost watch reports one error and ends",
    methods: ["watch"],
    hooks: ["deliver", "dropWatch"],
    async run({ adapter, deliver, dropWatch }) {
      const changes = [];
      const errors = [];
      await adapter.watch(["INBOX"], {
        onChange: (event) => changes.push(event),
        onError: (err) => errors.push(err),
      });
      await dropWatch(new MailError("NETWORK", "ECONNRESET"));
      assert.equal(errors.length, 1, "a lost connection reports once");
      assert.ok(errors[0] instanceof MailError);
      assert.equal(errors[0].code, "NETWORK");
      await dropWatch(new MailError("NETWORK", "ECONNRESET"));
      assert.equal(errors.length, 1, "the watcher is gone, so a second drop reports nothing");
      await deliver("INBOX", rawMessage({ subject: "after the drop" }));
      assert.deepEqual(changes, [], "a dropped watch reports no change");
    },
  },
  {
    name: "close is idempotent",
    methods: ["close"],
    hooks: [],
    async run({ adapter }) {
      await adapter.close();
      await adapter.close();
    },
  },
];

/**
 * Register the contract as one `node:test` case per step.
 * @param {(opts: object) => Promise<{adapter: object} & Record<string, Function>>} makeAdapter
 * @param {{skip?: string[]}} [options]
 */
export function runAdapterContract(makeAdapter, { skip = [] } = {}) {
  if (typeof makeAdapter !== "function") {
    throw new TypeError("runAdapterContract needs a factory function");
  }
  const skipped = new Set(skip);
  for (const step of STEPS) {
    const skipReason = [step.name, ...step.methods, ...step.hooks].find((name) => skipped.has(name));
    test(`adapter contract: ${step.name}`, { skip: skipReason ? `skipped ${skipReason}` : false }, async (t) => {
      const made = await makeAdapter(step.opts ?? {});
      const adapter = made && typeof made === "object" && made.adapter ? made.adapter : made;
      assertAdapter(adapter);
      const missingHook = step.hooks.find((hook) => typeof made?.[hook] !== "function");
      if (missingHook) {
        await adapter.close();
        t.skip(`the factory seeds without ${missingHook}`);
        return;
      }
      const ctx = { adapter, made };
      for (const hook of step.hooks) ctx[hook] = made[hook].bind(made);
      try {
        await step.run(ctx);
      } finally {
        await adapter.close();
      }
    });
  }
}