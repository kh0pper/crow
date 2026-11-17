/**
 * The adapter contract, in one place, run by every implementation's test file: the in-memory fake
 * (Task 11) and the imapflow + nodemailer adapter (Tasks 12 and 13). One list, so a change to one
 * implementation cannot drift from the other.
 *
 * `makeAdapter(opts)` is an async factory returning `{adapter, ...seeding hooks}`. How a message gets
 * into a mailbox is the server's business, not the contract's, so seeding is deliberately not part
 * of the adapter: the factory supplies `deliver`, `expunge`, `moveIn`, `bumpUidValidity`,
 * `resetUidValidity` (a UIDVALIDITY reset: a new value, an emptied mailbox and a uid space that starts
 * again at 1, so the next delivery takes the uid an earlier message held) and `dropWatch` (drop the
 * watch connection). Three hooks describe the wire rather than seed it: `commands()` is the list of
 * commands the server has received so far (the names only), `silenceNext(method)` makes the server
 * answer nothing, and `credentials()` is the list of credential strings seeded into the server (empty
 * when an implementation has none). A step whose hook the factory does not provide fails: a
 * factory that cannot seed a step is a gap in the implementation or in the test, not something to
 * pass over in silence. To leave a step out, name it — or a method it calls, or the hook it needs —
 * in `skip`. Only an exact name in that list skips anything; nothing is inferred from a missing
 * hook. `opts` carries the one per-server setting a step needs: `omitUidNext` (the server's listing
 * omits UIDNEXT). The factory returns a ready adapter: an implementation that needs a connection
 * calls its own `connect()` before handing it over, because how and when it connects is not part of
 * the contract.
 *
 * Two rules keep the assertions honest for an implementation that answers over a socket:
 *
 * - A "fires" assertion polls with `waitFor`, never reading a length in the same tick as the delivery
 *   that causes it. A real IDLE adapter pushes asynchronously, and the fake's synchronous push is the
 *   one that happens to be early.
 * - A "does not fire" assertion waits out a short `settle()` first, for the same reason inverted.
 *
 * `sinceDate` is a bound on the message's internal date, and RFC 3501's INTERNALDATE is
 * `DD-Mon-YYYY HH:MM:SS +0000`: a server carries whole seconds, so the finest pair a bound can be
 * asked to separate is two internal dates one second apart, and that is what the step uses.
 *
 * `skip` holds method names, hook names or step names. Task 12 passes `["saveDraft", "send"]` until
 * Task 13 implements them; each step declares the methods it uses, so that is enough.
 *
 * The action steps pin the two rules plan 2 adds: `setFlags` accepts `\Seen` and nothing else, and
 * both actions take the mailbox lock, compare the caller's `expectedUidValidity` with the value the
 * locked mailbox reports, and refuse with `CHANGED` before any STORE or MOVE when they differ.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAdapter } from "../../servers/gateway/mail/adapter/interface.js";
import { MailError, MAIL_ERROR_TEXT } from "../../servers/gateway/mail/errors.js";

/**
 * Poll a predicate until it holds. An adapter that reports a change from another socket answers a few
 * ticks after the delivery that caused it, so a "fires" assertion waits for the push.
 *
 * @param {() => boolean} predicate
 * @param {{timeoutMs?: number, intervalMs?: number}} [options]
 */
export async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for a condition`);
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
}

/**
 * Give an event that should not fire its chance to arrive. 50 ms is short next to a test's budget and
 * long next to a loopback round trip.
 */
export function settle(ms = 50) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Await a call that must reject with one MailError code, and answer with that error. */
async function expectCode(promise, code) {
  let caught = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof MailError, `expected a MailError (${code}), got ${caught && caught.name}`);
  assert.equal(caught.code, code);
  return caught;
}

/** The command names that change or read one message: what a refused action must never have sent. */
const ACTION_COMMAND = /STORE|COPY|MOVE|EXPUNGE|FETCH/;

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
      assert.equal(empty.uidNext, highest + 1, "an emptied page still reports the folder's next uid");
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
      assert.equal(listing.uidNext, 3, "the folder's highest uid plus one");
      const filtered = await adapter.list("INBOX", { afterUid: 2 });
      assert.equal(filtered.uidNext, 3, "a filtered-out page never reports a missing or smaller uidNext");
      const limited = await adapter.list("INBOX", { limit: 1 });
      assert.equal(limited.uidNext, 3, "a limited page counts the whole folder, not the page");
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
      assert.equal(page.uidNext, 6, "the page ends below the top, the next uid is still the folder's");
      const next = await adapter.list("INBOX", { beforeUid: 3, newestFirst: true, limit: 2 });
      assert.deepEqual(next.items.map((item) => item.uid), [2, 1]);
      assert.equal(next.uidNext, 6, "a lower page reports the same next uid as the first one");
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
    name: "sinceDate bounds the window to the second (INTERNALDATE resolution)",
    methods: ["list"],
    hooks: ["deliver"],
    async run({ adapter, deliver }) {
      // RFC 3501's INTERNALDATE has no fractional part, so two internal dates one second apart are the
      // closest pair a bound can be asked to tell apart on a real server.
      const t = Date.UTC(2026, 1, 2, 3, 4, 5);
      await deliver("INBOX", rawMessage({ subject: "old" }), { internalDate: t });
      await deliver("INBOX", rawMessage({ subject: "new" }), { internalDate: t + 1000 });
      const bound = await adapter.list("INBOX", { sinceDate: t + 1000 });
      assert.deepEqual(bound.items.map((item) => item.uid), [2], "the second before the bound is out");
      const inclusive = await adapter.list("INBOX", { sinceDate: t });
      assert.deepEqual(inclusive.items.map((item) => item.uid), [1, 2], "the bound itself is in");
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
    name: "appendToSent stores the raw copy in the sent folder with \\Seen",
    methods: ["appendToSent", "get"],
    hooks: [],
    async run({ adapter }) {
      const raw = rawMessage({ subject: "sent copy", body: "sent body marker" });
      const copy = await adapter.appendToSent(raw);
      assert.equal(typeof copy.folderPath, "string");
      assert.ok(copy.uid == null || Number.isInteger(copy.uid), "uid is a uid or null");
      if (copy.uid == null) return; // a server without UIDPLUS cannot name the appended message
      const [stored] = await adapter.get(copy.folderPath, [copy.uid]);
      assert.ok(stored, "the copy is fetchable at the uid it was appended as");
      assert.match(stored.raw.toString("utf8"), /sent body marker/);
      assert.ok(stored.flags.includes("\\Seen"), "the sent copy is marked seen");
      assert.equal(stored.flags.includes("\\Draft"), false, "and it is not a draft");
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
    name: "setFlags adds and removes \\Seen and reports the uids that changed",
    methods: ["setFlags", "list"],
    hooks: ["deliver"],
    async run({ adapter, deliver }) {
      const first = await deliver("INBOX", rawMessage({ subject: "first" }));
      const second = await deliver("INBOX", rawMessage({ subject: "second" }));
      const { uidValidity } = await adapter.list("INBOX");

      assert.deepEqual(
        await adapter.setFlags("INBOX", [first, second], { add: ["\\Seen"], expectedUidValidity: uidValidity }),
        { updated: 2 },
        "the count is the uids that existed",
      );
      let items = (await adapter.list("INBOX")).items;
      assert.deepEqual(items.map((item) => item.flags.includes("\\Seen")), [true, true], "both are seen now");

      assert.deepEqual(
        await adapter.setFlags("INBOX", [first], { remove: ["\\Seen"], expectedUidValidity: uidValidity }),
        { updated: 1 },
      );
      items = (await adapter.list("INBOX")).items;
      assert.equal(items.find((item) => item.uid === first).flags.includes("\\Seen"), false);
      assert.equal(items.find((item) => item.uid === second).flags.includes("\\Seen"), true,
        "a uid the call did not name keeps its flag");
    },
  },
  {
    name: "an action on a mailbox whose uidValidity changed is refused before anything is sent",
    methods: ["setFlags", "move", "list"],
    hooks: ["deliver", "resetUidValidity", "commands"],
    async run({ adapter, deliver, resetUidValidity, commands }) {
      const uid = await deliver("INBOX", rawMessage({ subject: "the message that was there" }));
      const { uidValidity } = await adapter.list("INBOX");
      const reset = await resetUidValidity("INBOX");
      assert.notEqual(reset, uidValidity, "the mailbox reports a new uidValidity");
      const replacement = await deliver("INBOX", rawMessage({ subject: "a different message" }), {
        flags: ["\\Flagged"],
      });
      assert.equal(replacement, uid, "the different message holds the same uid");

      let mark = commands().length;
      await expectCode(adapter.setFlags("INBOX", [uid], {
        add: ["\\Seen"], expectedUidValidity: uidValidity,
      }), "CHANGED");
      assert.deepEqual(commands().slice(mark).filter((name) => ACTION_COMMAND.test(name)), [],
        "no flag change was sent after the lock");

      mark = commands().length;
      await expectCode(adapter.move("INBOX", [uid], "Sent", { expectedUidValidity: uidValidity }), "CHANGED");
      assert.deepEqual(commands().slice(mark).filter((name) => ACTION_COMMAND.test(name)), [],
        "no move was sent after the lock");

      const inbox = await adapter.list("INBOX");
      assert.deepEqual(inbox.items.map((item) => item.uid), [uid], "the different message is still in the inbox");
      assert.deepEqual(inbox.items[0].flags, ["\\Flagged"], "and keeps the flags it arrived with");
      assert.deepEqual((await adapter.list("Sent")).items, [], "nothing arrived at the destination");
    },
  },
  {
    name: "a uid the mailbox no longer has changes nothing and counts zero",
    methods: ["setFlags", "move", "list"],
    hooks: ["deliver"],
    async run({ adapter, deliver }) {
      const first = await deliver("INBOX", rawMessage({ subject: "first" }));
      const second = await deliver("INBOX", rawMessage({ subject: "second" }));
      const { uidValidity } = await adapter.list("INBOX");
      const gone = second + 40;

      assert.deepEqual(
        await adapter.setFlags("INBOX", [first, gone], { add: ["\\Seen"], expectedUidValidity: uidValidity }),
        { updated: 1 },
        "only the uid that exists is counted",
      );
      const items = (await adapter.list("INBOX")).items;
      assert.equal(items.find((item) => item.uid === first).flags.includes("\\Seen"), true);
      assert.equal(items.find((item) => item.uid === second).flags.includes("\\Seen"), false);

      assert.deepEqual(
        await adapter.move("INBOX", [gone], "Sent", { expectedUidValidity: uidValidity }),
        { moved: 0 },
        "a vanished uid is not an error",
      );
      assert.deepEqual((await adapter.list("INBOX")).items.map((item) => item.uid), [first, second]);
      assert.deepEqual((await adapter.list("Sent")).items, [], "nothing was moved");
    },
  },
  {
    name: "both actions need the uidValidity the caller expects",
    methods: ["setFlags", "move"],
    hooks: [],
    async run({ adapter }) {
      for (const expectedUidValidity of [undefined, null, 0, -1, 1.5, "7", Number.NaN]) {
        await expectCode(adapter.setFlags("INBOX", [1], { add: ["\\Seen"], expectedUidValidity }), "BAD_INPUT");
        await expectCode(adapter.move("INBOX", [1], "Sent", { expectedUidValidity }), "BAD_INPUT");
      }
      await expectCode(adapter.setFlags("INBOX", [1], { add: ["\\Seen"] }), "BAD_INPUT");
      await expectCode(adapter.move("INBOX", [1], "Sent"), "BAD_INPUT");
    },
  },
  {
    name: "setFlags refuses every flag but \\Seen before it uses the connection",
    methods: ["setFlags"],
    hooks: ["commands"],
    async run({ adapter, commands }) {
      const before = commands().length;
      for (const flag of ["\\Deleted", "\\Flagged", "Seen", "\\\\Seen", "", 7, null]) {
        await expectCode(adapter.setFlags("INBOX", [1], { add: [flag], expectedUidValidity: 1 }), "BAD_INPUT");
        await expectCode(adapter.setFlags("INBOX", [1], { remove: [flag], expectedUidValidity: 1 }), "BAD_INPUT");
      }
      await expectCode(adapter.setFlags("INBOX", [1], { add: "\\Seen", expectedUidValidity: 1 }), "BAD_INPUT");
      assert.deepEqual(commands().slice(before), [], "a refused flag reached no command");
    },
  },
  {
    name: "move takes the message out of the source and puts it in the destination",
    methods: ["move", "list", "get"],
    hooks: ["deliver"],
    async run({ adapter, deliver }) {
      // Two messages already in the destination, so its own uid space is past the source's.
      await deliver("Sent", rawMessage({ subject: "already there" }));
      await deliver("Sent", rawMessage({ subject: "also there" }));
      const staying = await deliver("INBOX", rawMessage({ subject: "stays put" }));
      const moving = await deliver("INBOX", rawMessage({ subject: "move me", body: "moving body" }));
      const { uidValidity } = await adapter.list("INBOX");

      assert.deepEqual(
        await adapter.move("INBOX", [moving], "Sent", { expectedUidValidity: uidValidity }),
        { moved: 1 },
      );
      assert.deepEqual((await adapter.list("INBOX")).items.map((item) => item.uid), [staying],
        "the moved uid is gone from the source");
      const destination = (await adapter.list("Sent")).items;
      assert.equal(destination.length, 3, "the message arrived in the destination");
      const arrived = destination.find((item) => item.uid !== 1 && item.uid !== 2);
      assert.ok(arrived, "it took a uid of the destination's own");
      assert.notEqual(arrived.uid, moving, "and that uid is not the one it had in the source");
      const [stored] = await adapter.get("Sent", [arrived.uid]);
      assert.match(stored.raw.toString("utf8"), /moving body/);
    },
  },
  {
    name: "move to a folder that is not there is NOT_FOUND and leaves the source alone",
    methods: ["move", "list"],
    hooks: ["deliver"],
    async run({ adapter, deliver }) {
      const uid = await deliver("INBOX", rawMessage({ subject: "must not move" }));
      const { uidValidity } = await adapter.list("INBOX");
      await expectCode(adapter.move("INBOX", [uid], "NoSuchFolder", { expectedUidValidity: uidValidity }),
        "NOT_FOUND");
      assert.deepEqual((await adapter.list("INBOX")).items.map((item) => item.uid), [uid]);
    },
  },
  {
    name: "an action refuses more than 100 uids and an empty uid list",
    methods: ["setFlags", "move", "list"],
    hooks: ["deliver"],
    async run({ adapter, deliver }) {
      const uid = await deliver("INBOX", rawMessage({ subject: "one" }));
      const { uidValidity } = await adapter.list("INBOX");
      const many = Array.from({ length: 101 }, (_, index) => uid + index);
      await expectCode(adapter.setFlags("INBOX", many, { add: ["\\Seen"], expectedUidValidity: uidValidity }),
        "BAD_INPUT");
      await expectCode(adapter.move("INBOX", many, "Sent", { expectedUidValidity: uidValidity }), "BAD_INPUT");
      await expectCode(adapter.setFlags("INBOX", [], { add: ["\\Seen"], expectedUidValidity: uidValidity }),
        "BAD_INPUT");
      await expectCode(adapter.move("INBOX", [], "Sent", { expectedUidValidity: uidValidity }), "BAD_INPUT");
    },
  },
  {
    name: "a failed action carries one fixed sentence and no credential",
    methods: ["move", "list"],
    hooks: ["deliver", "credentials"],
    async run({ adapter, deliver, credentials }) {
      const uid = await deliver("INBOX", rawMessage({ subject: "keep me" }));
      const { uidValidity } = await adapter.list("INBOX");
      const err = await expectCode(
        adapter.move("INBOX", [uid], "NoSuchFolder", { expectedUidValidity: uidValidity }),
        "NOT_FOUND",
      );
      assert.equal(err.message, MAIL_ERROR_TEXT.NOT_FOUND);
      for (const field of ["response", "responseText", "executedCommand", "command"]) {
        assert.ok(!Object.hasOwn(err, field), `the library field ${field} does not travel`);
      }
      const shown = `${JSON.stringify(err)} ${String(err)} ${String(err.stack)}`;
      for (const secret of credentials()) {
        assert.ok(!shown.includes(secret), "no credential travels with the failure");
      }
      assert.ok(!shown.includes("NoSuchFolder"), "the folder name does not travel either");
      assert.deepEqual((await adapter.list("INBOX")).items.map((item) => item.uid), [uid]);
    },
  },
  {
    name: "an action the server never answers rejects TIMEOUT",
    methods: ["move", "list"],
    hooks: ["deliver", "silenceNext"],
    async run({ adapter, deliver, silenceNext }) {
      const uid = await deliver("INBOX", rawMessage({ subject: "quiet" }));
      const { uidValidity } = await adapter.list("INBOX");
      silenceNext("move");
      await expectCode(adapter.move("INBOX", [uid], "Sent", { expectedUidValidity: uidValidity }), "TIMEOUT");
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
      await waitFor(() => changes.length > 0);
      assert.equal(changes.length, 1, "a delivery in a watched folder reports a change");
      assert.equal(changes[0].folderPath, "INBOX");
      await deliver("Sent", rawMessage({ subject: "not watched" }));
      await settle();
      assert.equal(changes.length, 1, "a folder that is not watched reports nothing");
      watcher.stop();
      await deliver("INBOX", rawMessage({ subject: "after stop" }));
      await settle();
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
      await waitFor(() => errors.length > 0);
      assert.equal(errors.length, 1, "a lost connection reports once");
      assert.ok(errors[0] instanceof MailError);
      assert.equal(errors[0].code, "NETWORK");
      await dropWatch(new MailError("NETWORK", "ECONNRESET"));
      await settle();
      assert.equal(errors.length, 1, "the watcher is gone, so a second drop reports nothing");
      await deliver("INBOX", rawMessage({ subject: "after the drop" }));
      await settle();
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
 * Register the contract as one case per step.
 *
 * @param {(opts: object) => Promise<{adapter: object} & Record<string, Function>>} makeAdapter
 * @param {{skip?: string[], register?: (name: string, options: object, fn: Function) => void}} [options]
 *   `register` is `node:test`'s `test` unless a test wants to collect the steps and inspect them
 *   instead of running them.
 */
export function runAdapterContract(makeAdapter, { skip = [], register = test } = {}) {
  if (typeof makeAdapter !== "function") {
    throw new TypeError("runAdapterContract needs a factory function");
  }
  if (typeof register !== "function") {
    throw new TypeError("runAdapterContract needs register() to be a function");
  }
  // Only an exact name in `skip` leaves a step out: the step's own name, one of the methods it calls,
  // or one of the seeding hooks it needs. Nothing else skips anything.
  const skipped = new Set(skip);
  for (const step of STEPS) {
    const skipReason = [step.name, ...step.methods, ...step.hooks].find((name) => skipped.has(name));
    register(`adapter contract: ${step.name}`, { skip: skipReason ? `skipped ${skipReason}` : false }, async () => {
      const made = await makeAdapter(step.opts ?? {});
      const adapter = made && typeof made === "object" && made.adapter ? made.adapter : made;
      assertAdapter(adapter);
      const missing = step.hooks.filter((hook) => typeof made?.[hook] !== "function");
      if (missing.length) {
        await adapter.close();
        assert.fail(
          `the factory does not supply ${missing.join(", ")}, which this step needs; `
          + "name the hook, a method or the step in skip to leave the step out",
        );
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