// Crow Mail's adapter contract and outgoing-message rule (Task 11 of plan 1), run against the
// in-memory fake. The contract itself lives in tests/fixtures/mail-adapter-contract.mjs so the
// imapflow + nodemailer adapter runs the same list in Task 12. Nothing here needs a network, a
// scratch DB or a clock: the fake holds the mailboxes in memory and its hooks are the seeding path.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTER_METHODS, assertAdapter, validateOutgoing,
} from "../servers/gateway/mail/adapter/interface.js";
import { MailError } from "../servers/gateway/mail/errors.js";
import { createFakeMailAdapter } from "./fixtures/fake-mail-adapter.mjs";
import { rawMessage, runAdapterContract } from "./fixtures/mail-adapter-contract.mjs";

/** The contract's factory: the fake itself is the adapter, its hooks are the seeding hooks. */
function makeAdapter(opts = {}) {
  const fake = createFakeMailAdapter(opts);
  return {
    adapter: fake,
    deliver: fake.deliver,
    expunge: fake.expunge,
    moveIn: fake.moveIn,
    bumpUidValidity: fake.bumpUidValidity,
    dropWatch: fake.dropWatch,
    emit: fake.emit,
  };
}

runAdapterContract(async (opts = {}) => makeAdapter(opts));

/* --------------------------------------------------------------- the contract's skip rule */

/** Collect the steps the contract would register instead of running them. */
function collect(factory, options = {}) {
  const steps = [];
  runAdapterContract(factory, {
    ...options,
    register: (name, testOptions, fn) => steps.push({ name, options: testOptions, fn }),
  });
  return steps;
}

const LOST_WATCH = "adapter contract: a lost watch reports one error and ends";

test("the contract skips exactly the steps whose names are in skip", () => {
  // The seam Task 12 uses while the IMAP adapter has no send/saveDraft yet.
  const steps = collect(async (opts = {}) => makeAdapter(opts), { skip: ["saveDraft", "send"] });
  const skipped = steps.filter((step) => step.options.skip !== false).map((step) => step.name);
  assert.deepEqual(skipped, [
    "adapter contract: saveDraft stores the raw text in a drafts folder",
    "adapter contract: send returns a messageId and the addresses it accepted",
  ]);
  const ran = steps.filter((step) => step.options.skip === false).map((step) => step.name);
  assert.equal(ran.length, steps.length - 2, "every step outside the two named ones still runs");
  assert.ok(ran.includes("adapter contract: watch reports a change in a watched folder and stop() ends it"),
    "a step that uses neither method is unaffected");
  assert.equal(steps.find((step) => step.name === LOST_WATCH).options.skip, false);
});

test("a missing seeding hook fails its step unless skip names it", async () => {
  const withoutDropWatch = async (opts = {}) => {
    const made = makeAdapter(opts);
    delete made.dropWatch;
    return made;
  };

  const steps = collect(withoutDropWatch);
  const lost = steps.find((step) => step.name === LOST_WATCH);
  assert.ok(lost, "the step is registered");
  assert.equal(lost.options.skip, false, "an unlisted missing hook is not quietly a skip");
  await assert.rejects(lost.fn(), /dropWatch/, "the step fails and says which hook it needs");
  assert.equal(steps.filter((step) => step.options.skip !== false).length, 0,
    "no other step is skipped either");

  const byHook = collect(withoutDropWatch, { skip: ["dropWatch"] });
  assert.equal(byHook.find((step) => step.name === LOST_WATCH).options.skip, "skipped dropWatch");

  const byName = collect(withoutDropWatch, { skip: ["a lost watch reports one error and ends"] });
  assert.equal(byName.find((step) => step.name === LOST_WATCH).options.skip,
    "skipped a lost watch reports one error and ends");

  const nearMiss = collect(withoutDropWatch, { skip: ["drop", "watches"] });
  assert.equal(nearMiss.find((step) => step.name === LOST_WATCH).options.skip, false,
    "only an exact name in skip matches");
});

/* ---------------------------------------------------------------- the method list */

test("assertAdapter accepts the fake and names the method an adapter is missing", () => {
  const fake = createFakeMailAdapter();
  assert.equal(assertAdapter(fake), fake, "the same object comes back, so a factory can return it");

  const incomplete = createFakeMailAdapter();
  delete incomplete.send;
  assert.throws(() => assertAdapter(incomplete), (err) => {
    assert.ok(err instanceof TypeError);
    assert.match(err.message, /send/);
    return true;
  });

  assert.throws(() => assertAdapter(null), TypeError);
  assert.throws(() => assertAdapter({}), (err) => /connect/.test(err.message));
});

test("the method list is the nine the plan names, in order", () => {
  assert.deepEqual([...ADAPTER_METHODS], [
    "connect", "close", "listFolders", "list", "get", "search", "saveDraft", "send", "watch",
  ]);
  assert.ok(Object.isFrozen(ADAPTER_METHODS));
});

/* ------------------------------------------------------------ validateOutgoing: refusals */

function outgoing(overrides = {}) {
  return {
    from: { name: "Alex", address: "alex@example.com" },
    to: [{ address: "sam@example.com" }],
    subject: "Hello",
    text: "A body.",
    ...overrides,
  };
}

function badInput(detail) {
  return (err) => {
    assert.ok(err instanceof MailError, `expected a MailError, got ${err && err.name}`);
    assert.equal(err.code, "BAD_INPUT");
    if (detail) assert.equal(err.detail, detail);
    return true;
  };
}

test("validateOutgoing refuses an envelope, an unknown key and a missing body", () => {
  assert.throws(() => validateOutgoing(outgoing({ envelope: { to: ["x@example.com"] } })), badInput("envelope"));
  assert.throws(() => validateOutgoing(outgoing({ headers: { Bcc: "x@example.com" } })), badInput());
  assert.throws(() => validateOutgoing(outgoing({ text: "", html: null })), badInput("body"));
  assert.throws(() => validateOutgoing(null), badInput());
});

test("validateOutgoing refuses a recipient that is not exactly one clean address", () => {
  const hostile = [
    "sam@example.com>\r\nBcc: x@example.com",
    "sam@example.com\nBcc: x@example.com",
    "sam@example.com>",
    "<sam@example.com>",
    "Sam <sam@example.com>",
    "sam@example.com, kim@example.com",
    "Team: sam@example.com;",
    "not-an-address",
    "",
  ];
  for (const address of hostile) {
    const shown = JSON.stringify(address);
    assert.throws(() => validateOutgoing(outgoing({ to: [{ address }] })), badInput("to"), shown);
    assert.throws(() => validateOutgoing(outgoing({ to: [address] })), badInput("to"), `bare ${shown}`);
  }
  // A bare `>` in the From field is the same injection one field over.
  assert.throws(() => validateOutgoing(outgoing({ from: { address: "alex@example.com>\r\nBcc: x@example.com" } })),
    badInput("from"));
  // A recipient entry may carry only a name and an address.
  assert.throws(() => validateOutgoing(outgoing({ to: [{ name: "Sam", address: "sam@example.com", smtp: "x" }] })),
    badInput("to"));
});

test("validateOutgoing refuses an edge newline on every address field", () => {
  // The control-character test comes before the trim, so an edge newline is refused on all four
  // fields instead of being trimmed away and the address accepted.
  const edges = ["sam@example.com\n", "sam@example.com\r", "\rsam@example.com", "\nsam@example.com"];
  for (const address of edges) {
    const shown = JSON.stringify(address);
    assert.throws(() => validateOutgoing(outgoing({ from: { address } })), badInput("from"), shown);
    assert.throws(() => validateOutgoing(outgoing({ to: [{ address }] })), badInput("to"), shown);
    assert.throws(() => validateOutgoing(outgoing({ cc: [{ address }] })), badInput("cc"), shown);
    assert.throws(() => validateOutgoing(outgoing({ bcc: [{ address }] })), badInput("bcc"), shown);
    assert.throws(() => validateOutgoing(outgoing({ to: [address] })), badInput("to"), `bare ${shown}`);
    assert.throws(() => validateOutgoing(outgoing({ to: [{ name: "Sam", address }] })), badInput("to"), shown);
  }
  // Surrounding spaces are still padding, not an injection attempt.
  const padded = validateOutgoing(outgoing({ to: [{ address: "  sam@example.com  " }] }));
  assert.equal(padded.to[0].address, "sam@example.com");
});

test("validateOutgoing refuses a control character in a subject or a message id and strips one from display text", () => {
  // A subject keeps its CR/LF rule (one space) but nothing else: any other control is refused.
  for (const subject of ["Hi\u0000there", "Hi\u0007", "Hi\u001b", "Hi\u007f"]) {
    assert.throws(() => validateOutgoing(outgoing({ subject })), badInput("subject"), JSON.stringify(subject));
  }
  // Display text is the caller's, so the control character goes and the words stay.
  const out = validateOutgoing(outgoing({
    from: { name: "Al\u0000ex\u0007", address: "alex@example.com" },
    to: [{ name: "Sa\u0000m", address: "sam@example.com" }],
    subject: "Hello\r\nWorld",
  }));
  assert.equal(out.from.name, "Alex");
  assert.equal(out.to[0].name, "Sam");
  assert.equal(out.subject, "Hello World", "a CR/LF run is still one space");
  // Ids are refused, and a bracketed id is no exception.
  for (const id of ["<a\u0000b@example.com>", "<a\u0007b@example.com>", "<a\u007fb@example.com>"]) {
    const shown = JSON.stringify(id);
    assert.throws(() => validateOutgoing(outgoing({ inReplyTo: id })), badInput("inReplyTo"), shown);
    assert.throws(() => validateOutgoing(outgoing({ references: [id] })), badInput("references"), shown);
  }
});

test("validateOutgoing refuses an attachment media type that is not a type/subtype token", () => {
  const hostile = [
    "text/plain\r\nBcc: x@example.com",
    "text/plain\nBcc: x@example.com",
    "text/plain\r\n",
    "text/plain; charset=utf-8\r\nBcc: x@example.com",
    "text/plain\u0000",
    "text",
    "text/",
    "/plain",
    "text/pl ain",
    "te xt/plain",
    "-text/plain",
    "text/plain/extra",
  ];
  for (const contentType of hostile) {
    const shown = JSON.stringify(contentType);
    assert.throws(() => validateOutgoing(outgoing({
      attachments: [{ filename: "note.txt", contentType, content: Buffer.from("x") }],
    })), badInput("attachments"), shown);
  }
  // A real media type passes, with and without parameters.
  for (const contentType of ["text/plain", "application/octet-stream", "image/svg+xml", "text/plain; charset=utf-8"]) {
    const out = validateOutgoing(outgoing({
      attachments: [{ filename: "note.txt", contentType, content: Buffer.from("x") }],
    }));
    assert.equal(out.attachments[0].contentType, contentType);
  }
});

test("validateOutgoing refuses a message id with CR/LF or without brackets", () => {
  for (const inReplyTo of ["<a@example.com>\r\n", "<a@example.com>\nBcc: x@example.com", "a@example.com", "<a b@example.com>", "<>"]) {
    assert.throws(() => validateOutgoing(outgoing({ inReplyTo })), badInput("inReplyTo"), JSON.stringify(inReplyTo));
  }
  assert.throws(() => validateOutgoing(outgoing({ references: ["<a@example.com>\r\n"] })), badInput("references"));
});

/* --------------------------------------------------------- validateOutgoing: normalisation */

test("validateOutgoing keeps the last 50 of 60 references", () => {
  const references = Array.from({ length: 60 }, (_, i) => `<ref-${i + 1}@example.com>`);
  const out = validateOutgoing(outgoing({ references }));
  assert.equal(out.references.length, 50);
  assert.equal(out.references[0], "<ref-11@example.com>", "the oldest ids go, the tail stays");
  assert.equal(out.references.at(-1), "<ref-60@example.com>");
  assert.deepEqual(validateOutgoing(outgoing({ references: [] })).references, []);
});

test("validateOutgoing strips CR/LF from a display name and collapses a subject's CR/LF", () => {
  const out = validateOutgoing(outgoing({
    from: { name: "Alex\r\nBcc: x@example.com", address: "Alex@Example.com" },
    to: [{ name: "Sam\nSmith", address: "sam@example.com" }],
    subject: "Hello\r\n\r\nWorld",
  }));
  assert.equal(out.from.name, "AlexBcc: x@example.com", "the CR/LF is gone, the text is not");
  assert.equal(out.to[0].name, "SamSmith");
  assert.equal(out.subject, "Hello World", "a CR/LF run is one space");
  assert.equal(out.from.address, "alex@example.com", "the address is the lower-cased addr-spec");

  const clean = validateOutgoing(outgoing({ from: { address: "alex@example.com" }, subject: "  Re: hi  " }));
  assert.equal(clean.from.name, null);
  assert.equal(clean.subject, "Re: hi");
  assert.deepEqual(clean.cc, []);
  assert.deepEqual(clean.bcc, []);
  assert.equal(clean.html, null);
  assert.equal(clean.inReplyTo, null);
  assert.deepEqual(clean.attachments, []);
});

test("validateOutgoing keeps only the allowed fields, so nothing else can reach a header", () => {
  const out = validateOutgoing(outgoing({
    cc: [{ name: "Kim", address: "kim@example.com" }],
    bcc: ["lee@example.com"],
    inReplyTo: "<parent@example.com>",
    references: ["<root@example.com>", "<parent@example.com>"],
    attachments: [{ filename: "notes.txt", contentType: "text/plain", content: Buffer.from("x") }],
  }));
  assert.deepEqual(Object.keys(out).sort(), [
    "attachments", "bcc", "cc", "from", "html", "inReplyTo", "references", "subject", "text", "to",
  ]);
  assert.deepEqual(out.bcc, [{ name: null, address: "lee@example.com" }]);
  assert.equal(out.inReplyTo, "<parent@example.com>");
  assert.equal(out.attachments[0].filename, "notes.txt");

  // A filename is header-adjacent too: its CR/LF is removed rather than carried into the part header.
  const named = validateOutgoing(outgoing({
    attachments: [{ filename: "notes\r\nBcc: x@example.com.txt", content: Buffer.from("x") }],
  }));
  assert.equal(named.attachments[0].filename, "notesBcc: x@example.com.txt");
  assert.equal(named.attachments[0].contentType, "application/octet-stream", "the default type is fixed here");
  assert.throws(() => validateOutgoing(outgoing({
    attachments: [{ filename: "x.txt", content: Buffer.from("x"), path: "/etc/passwd" }],
  })), badInput("attachments"), "no path or href rides along with an attachment");
});

/* ---------------------------------------------------------------- failure injection */

test("failNext fails exactly one call, with the injected MailError", async () => {
  const fake = createFakeMailAdapter();
  fake.deliver("INBOX", rawMessage({ subject: "one" }));
  const injected = new MailError("NETWORK", "ECONNRESET");
  assert.equal(fake.failNext("list", injected), injected);

  await assert.rejects(fake.list("INBOX"), (err) => {
    assert.equal(err, injected, "the injected error is what the caller sees");
    return true;
  });
  const listing = await fake.list("INBOX");
  assert.equal(listing.items.length, 1, "the next call works again");

  assert.throws(() => fake.failNext("list", new Error("not a MailError")), TypeError);
});

test("hangNext leaves the next call unsettled and the one after it working", async () => {
  const fake = createFakeMailAdapter();
  fake.hangNext("list");
  const hung = await Promise.race([
    fake.list("INBOX").then(() => "settled"),
    new Promise((resolve) => { setTimeout(() => resolve("hung"), 20); }),
  ]);
  assert.equal(hung, "hung", "a hung call never settles");
  const listing = await fake.list("INBOX");
  assert.deepEqual(listing.items, [], "the hang was consumed by the first call");
});

test("the fake records what an implementation would have put on the wire", async () => {
  const fake = createFakeMailAdapter();
  const raw = rawMessage({ subject: "draft", body: "draft body" });
  const saved = await fake.saveDraft(raw);
  assert.equal(saved.folderPath, "Drafts");
  assert.equal(fake.drafts.length, 1);
  assert.equal(fake.drafts[0].folderPath, "Drafts");
  assert.match(fake.drafts[0].raw.toString("utf8"), /draft body/);

  const result = await fake.send({
    from: { name: "Alex", address: "alex@example.com" },
    to: [{ address: "sam@example.com" }],
    subject: "Hi",
    text: "Body.",
  });
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].messageId, result.messageId);
  assert.deepEqual(result.accepted, ["sam@example.com"]);
  assert.ok(fake.calls.some((call) => call.method === "send"));

  // close is idempotent, and a closed adapter refuses data calls instead of pretending.
  await fake.close();
  await fake.close();
  await assert.rejects(fake.list("INBOX"), (err) => {
    assert.ok(err instanceof MailError);
    assert.equal(err.code, "PROTOCOL");
    return true;
  });
});

/* -------------------------------------------------------- the seeding hooks */

test("moveIn keeps an old date at a new uid, and expunge takes a uid out", async () => {
  const fake = createFakeMailAdapter();
  const old = Date.UTC(2025, 0, 1);
  const moved = fake.moveIn("INBOX", rawMessage({ subject: "moved in" }), { internalDate: old });
  const delivered = fake.deliver("INBOX", rawMessage({ subject: "delivered" }));
  assert.equal(delivered, moved + 1, "moveIn appends at the mailbox's next uid");

  const listing = await fake.list("INBOX");
  assert.deepEqual(listing.items.map((item) => item.uid), [moved, delivered]);
  assert.equal(listing.items[0].internalDate, old, "the message keeps the old date it was moved in with");
  assert.throws(() => fake.moveIn("INBOX", rawMessage()), (err) => {
    assert.ok(err instanceof MailError);
    assert.equal(err.code, "BAD_INPUT");
    return true;
  });

  assert.equal(fake.expunge("INBOX", moved), 1);
  assert.deepEqual((await fake.list("INBOX")).items.map((item) => item.uid), [delivered]);
  assert.equal(fake.expunge("INBOX", moved), 0, "expunging a uid the mailbox no longer has removes nothing");

  fake.deliver("INBOX", rawMessage({ subject: "deleted" }), { flags: ["\\Deleted"] });
  assert.equal(fake.expunge("INBOX"), 1, "no uid means every \\Deleted message");
  assert.equal((await fake.list("INBOX")).items.length, 1);
});

test("a throwing onChange handler does not fail the delivery or the other watchers", async () => {
  const fake = createFakeMailAdapter();
  const seen = [];
  await fake.watch(["INBOX"], { onChange: () => { throw new Error("a handler bug"); } });
  await fake.watch(["INBOX"], { onChange: (event) => seen.push(event) });
  let uid;
  assert.doesNotThrow(() => { uid = fake.deliver("INBOX", rawMessage({ subject: "arrived" })); });
  assert.equal(uid, 1, "the delivery still returns the uid it was given");
  assert.deepEqual(seen, [{ folderPath: "INBOX", reason: "exists" }],
    "the watcher after the throwing one still hears the change");
});

test("omitUidNext answers the folder's next uid, not the page's", async () => {
  const fake = createFakeMailAdapter({ omitUidNext: true });
  for (const subject of ["one", "two", "three"]) fake.deliver("INBOX", rawMessage({ subject }));

  const page = await fake.list("INBOX", { limit: 1, newestFirst: true });
  assert.deepEqual(page.items.map((item) => item.uid), [3]);
  assert.equal(page.uidNext, 4, "the highest uid in the folder plus one");

  const past = await fake.list("INBOX", { afterUid: 3 });
  assert.deepEqual(past.items, [], "the last message the mailbox answers with is filtered back out");
  assert.equal(past.uidNext, 4, "an emptied page still reports the folder's uidNext");

  const empty = createFakeMailAdapter({ omitUidNext: true });
  assert.equal((await empty.list("INBOX")).uidNext, 1, "an empty folder answers 1");
});

test("list bounds the window at whole seconds, which is what a server's INTERNALDATE carries", async () => {
  const fake = createFakeMailAdapter();
  const t = Date.UTC(2026, 1, 2, 3, 4, 5);
  fake.deliver("INBOX", rawMessage({ subject: "old" }), { internalDate: t });
  fake.deliver("INBOX", rawMessage({ subject: "new" }), { internalDate: t + 1000 });
  assert.deepEqual((await fake.list("INBOX", { sinceDate: t + 1000 })).items.map((item) => item.uid), [2]);
  assert.deepEqual((await fake.list("INBOX", { sinceDate: t })).items.map((item) => item.uid), [1, 2],
    "the bound itself is in");
});

test("bumpUidValidity changes the value the next listing reports, and emit wakes watchers", async () => {
  const fake = createFakeMailAdapter();
  const before = (await fake.list("INBOX")).uidValidity;
  assert.equal(fake.bumpUidValidity("INBOX"), before + 1);
  assert.equal((await fake.list("INBOX")).uidValidity, before + 1, "the messages are unchanged, the identity is not");

  const seen = [];
  await fake.watch(["INBOX"], { onChange: (event) => seen.push(event) });
  fake.emit("INBOX", "flags");
  fake.emit("Archive");
  assert.deepEqual(seen, [{ folderPath: "INBOX", reason: "flags" }], "only a watched folder reports");

  assert.throws(() => fake.deliver("No Such Folder", rawMessage()), (err) => {
    assert.ok(err instanceof MailError);
    assert.equal(err.code, "NOT_FOUND");
    return true;
  });
});