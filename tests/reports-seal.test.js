// Crow Recurring Reports' approval seal: the HMAC an owner approval writes, the length-prefixed,
// type-tagged, per-kind fields it binds, and the one thing it must never do — verify for anything that
// is not exactly the seal this key made. The mail tap seal is imported here, and only here, to show
// that the two domains are different keys over the same seed. The last test reads the reports modules'
// own text, to keep `mail/` out of their import closure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  APPROVAL_KINDS, APPROVAL_SEAL_DOMAIN, SEAL_FIELDS, approvalSeal, newApprovalNonce,
  verifyApprovalSeal,
} from "../servers/gateway/reports/seal.js";
import { sealFor, verifySeal } from "../servers/gateway/mail/drafts/seal.js";

const SEED = Buffer.alloc(32, 7);
const OTHER_SEED = Buffer.alloc(32, 8);

/** One sample of every kind's fields, each with its own fresh nonce. */
function sample(kind, overrides = {}) {
  const nonce = newApprovalNonce();
  const base = {
    live: {
      reportId: "rpt-0011223344556677",
      rev: 3,
      recipeHash: "a".repeat(64),
      sourcesHash: "b".repeat(64),
      cron: "0 7 * * 1",
      tz: "Europe/Berlin",
      senderAccountId: "ma-0011223344556677",
      botId: "bot-1",
      projectId: 7,
      artifactId: "art-0011223344556677",
      scheduleId: 12,
      deliveryMode: "email_link",
      commentTierDefault: "c",
      commentVisibility: "own",
      aiCommentary: 0,
      modelRef: "",
      nonce,
    },
    recipient: {
      reportId: "rpt-0011223344556677",
      recipientId: "rcp-0011223344556677",
      address: "sam@example.com",
      commentTier: "b",
      nonce,
    },
    step: {
      reportId: "rpt-0011223344556677",
      stepId: "booking-lookup",
      bundleHash: "c".repeat(64),
      nonce,
    },
    host: { reportId: "rpt-0011223344556677", host: "api.example.test", nonce },
    credential: {
      reportId: "rpt-0011223344556677",
      credentialRef: "cred-0011223344556677",
      host: "api.example.test",
      nonce,
    },
    proposal: {
      reportId: "rpt-0011223344556677",
      proposalId: "prp-0011223344556677",
      baseRev: 4,
      diffHash: "d".repeat(64),
      nonce,
    },
  }[kind];
  assert.ok(base, `no sample for kind ${kind}`);
  return { ...base, ...overrides };
}

/** A different value of the same type, so the field is changed without changing its tag. */
function changed(value) {
  if (typeof value === "number") return value + 1;
  return `${value}x`;
}

test("the domain, the kinds and each kind's field order are fixed", () => {
  assert.equal(APPROVAL_SEAL_DOMAIN, "crow-reports-approval-v1");
  assert.deepEqual([...APPROVAL_KINDS], ["live", "recipient", "step", "host", "credential", "proposal"]);
  assert.ok(Object.isFrozen(APPROVAL_KINDS));
  assert.deepEqual([...SEAL_FIELDS.live], [
    "reportId", "rev", "recipeHash", "sourcesHash", "cron", "tz", "senderAccountId",
    "botId", "projectId", "artifactId", "scheduleId",
    "deliveryMode", "commentTierDefault", "commentVisibility", "aiCommentary", "modelRef", "nonce",
  ]);
  assert.equal(SEAL_FIELDS.live.includes("title"), false,
    "a title is a label, not something the owner approves");
  assert.deepEqual([...SEAL_FIELDS.recipient],
    ["reportId", "recipientId", "address", "commentTier", "nonce"]);
  assert.deepEqual([...SEAL_FIELDS.step], ["reportId", "stepId", "bundleHash", "nonce"]);
  assert.deepEqual([...SEAL_FIELDS.host], ["reportId", "host", "nonce"]);
  assert.deepEqual([...SEAL_FIELDS.credential], ["reportId", "credentialRef", "host", "nonce"]);
  assert.deepEqual([...SEAL_FIELDS.proposal],
    ["reportId", "proposalId", "baseRev", "diffHash", "nonce"]);
  for (const kind of APPROVAL_KINDS) {
    assert.equal(SEAL_FIELDS[kind].at(-1), "nonce", `${kind} binds its nonce last`);
  }
});

test("a nonce is 32 lower-case hex characters", () => {
  const nonces = new Set();
  for (let i = 0; i < 32; i += 1) {
    const nonce = newApprovalNonce();
    assert.match(nonce, /^[0-9a-f]{32}$/);
    nonces.add(nonce);
  }
  assert.equal(nonces.size, 32, "no two nonces repeat");
});

test("every kind seals and verifies over its own fields", () => {
  for (const kind of APPROVAL_KINDS) {
    const fields = sample(kind);
    const seal = approvalSeal(kind, fields, SEED);
    assert.match(seal, /^[0-9a-f]{64}$/, `${kind} seal is 64 lower-case hex`);
    assert.equal(verifyApprovalSeal(kind, fields, seal, SEED), true, `${kind} round trip`);
    assert.equal(verifyApprovalSeal(kind, fields, seal, OTHER_SEED), false,
      `${kind} does not verify under another keychain seed`);
  }
});

test("a changed field does not verify, for every field of every kind", () => {
  for (const kind of APPROVAL_KINDS) {
    const fields = sample(kind);
    const seal = approvalSeal(kind, fields, SEED);
    for (const name of SEAL_FIELDS[kind]) {
      const mutated = { ...fields, [name]: changed(fields[name]) };
      assert.equal(verifyApprovalSeal(kind, mutated, seal, SEED), false,
        `${kind}.${name} is covered by the seal`);
    }
  }
});

test("a seal for one kind never verifies as another kind", () => {
  for (const made of APPROVAL_KINDS) {
    const seal = approvalSeal(made, sample(made), SEED);
    for (const other of APPROVAL_KINDS) {
      if (other === made) continue;
      assert.equal(verifyApprovalSeal(other, sample(other), seal, SEED), false,
        `a ${made} seal is not a ${other} seal`);
    }
  }
});

test("a mail tap seal over comparable bytes never verifies as a reports seal", () => {
  // The same values, the same seed, the same length-prefixed encoding: only the domain subkey and the
  // kind tag differ, and that is enough to make them different keys.
  const fields = { reportId: "rpt-0011223344556677", host: "api.example.test", nonce: newApprovalNonce() };
  const tapFields = {
    draftId: fields.reportId,
    headHash: fields.host,
    action: "send",
    when: 1_700_000_000_000,
    attachDigest: "digest-1",
    accountId: "ma-0011223344556677",
    fromAddress: "alex@example.com",
    tapId: fields.nonce,
  };
  const tapSeal = sealFor(tapFields, SEED);
  assert.match(tapSeal, /^[0-9a-f]{64}$/);
  for (const kind of APPROVAL_KINDS) {
    assert.equal(verifyApprovalSeal(kind, sample(kind), tapSeal, SEED), false,
      `a mail tap seal is not a ${kind} approval`);
    assert.equal(verifyApprovalSeal(kind, tapFields, tapSeal, SEED), false,
      `a mail tap seal is not a ${kind} approval even with its own fields`);
  }
  const reportsSeal = approvalSeal("host", fields, SEED);
  assert.notEqual(reportsSeal, tapSeal);
  assert.equal(verifySeal(tapFields, reportsSeal, SEED), false, "and the reports seal is not a tap");
});

test("an upper-case, truncated, padded or absent seal is refused", () => {
  const fields = sample("live");
  const seal = approvalSeal("live", fields, SEED);
  const upperCase = seal.replace(/[a-f]/g, (c) => c.toUpperCase());
  assert.notEqual(upperCase, seal);
  assert.equal(verifyApprovalSeal("live", fields, upperCase, SEED), false);
  assert.equal(verifyApprovalSeal("live", fields, seal.slice(0, 62), SEED), false);
  assert.equal(verifyApprovalSeal("live", fields, `${seal}00`, SEED), false);
  assert.equal(verifyApprovalSeal("live", fields, ` ${seal.slice(1)}`, SEED), false);
  assert.equal(verifyApprovalSeal("live", fields, `${seal.slice(0, 63)}g`, SEED), false);
  assert.equal(verifyApprovalSeal("live", fields, "", SEED), false);
  assert.equal(verifyApprovalSeal("live", fields, null, SEED), false);
  assert.equal(verifyApprovalSeal("live", fields, undefined, SEED), false);
  assert.equal(verifyApprovalSeal("live", fields, 42, SEED), false);
  assert.equal(verifyApprovalSeal("live", fields, Buffer.from(seal, "hex"), SEED), false);
  // One seal has one spelling: the character-changed copy is refused too.
  const flipped = `${seal[0] === "0" ? "1" : "0"}${seal.slice(1)}`;
  assert.equal(verifyApprovalSeal("live", fields, flipped, SEED), false);
});

test("an empty string is sealed distinctly from a number, and from its own text", () => {
  const fields = sample("live");
  assert.equal(fields.modelRef, "", "the live set has a none-valued field");
  const withEmpty = approvalSeal("live", fields, SEED);
  const withZero = approvalSeal("live", { ...fields, modelRef: 0 }, SEED);
  const withZeroText = approvalSeal("live", { ...fields, modelRef: "0" }, SEED);
  assert.equal(verifyApprovalSeal("live", fields, withEmpty, SEED), true);
  assert.equal(verifyApprovalSeal("live", { ...fields, modelRef: 0 }, withEmpty, SEED), false);
  assert.equal(verifyApprovalSeal("live", { ...fields, modelRef: "0" }, withEmpty, SEED), false);
  assert.notEqual(withEmpty, withZero);
  assert.notEqual(withEmpty, withZeroText);
  // A number and its decimal text are different fields even one field over.
  const numeric = sample("proposal");
  assert.notEqual(
    approvalSeal("proposal", numeric, SEED),
    approvalSeal("proposal", { ...numeric, baseRev: String(numeric.baseRev) }, SEED),
  );
});

test("the field encoding is length-prefixed, so two spellings cannot hash alike", () => {
  const fields = sample("host");
  const split = approvalSeal("host", { ...fields, host: "ab", nonce: fields.nonce }, SEED);
  const other = approvalSeal("host", { ...fields, host: "a", nonce: fields.nonce }, SEED);
  assert.notEqual(split, other);
  assert.equal(verifyApprovalSeal("host", { ...fields, host: "ab" }, split, SEED), true);
  assert.equal(verifyApprovalSeal("host", { ...fields, host: "a" }, split, SEED), false);
});

test("no reports module imports a mail module: the seal and the store stand alone", () => {
  const dir = new URL("../servers/gateway/reports/", import.meta.url);
  const files = ["approvals.js", "seal.js", "store.js", "recipe-hash.js", "caps.js"];
  for (const name of files) {
    const src = readFileSync(new URL(name, dir), "utf8");
    // Only import specifiers count, not the prose in a comment that names the mail seal.
    const specifiers = [
      ...src.matchAll(/\bfrom\s+["']([^"']+)["']/g),
      ...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);
    assert.ok(specifiers.length > 0 || name === "caps.js", `${name} has imports to check`);
    for (const specifier of specifiers) {
      assert.equal(specifier.includes("mail/"), false, `${name} imports ${specifier}`);
    }
  }
  // The one file that may reach mail is the sender reader the routes inject.
  const ready = readFileSync(new URL("sender-ready.js", dir), "utf8");
  assert.match(ready, /from "\.\.\/mail\//, "sender-ready.js is where the mail read lives");
});

test("a fresh nonce is a fresh seal, and an old seal never verifies for the new one", () => {
  const first = sample("recipient");
  const second = sample("recipient", { nonce: newApprovalNonce() });
  assert.equal(first.address, second.address);
  const seal = approvalSeal("recipient", first, SEED);
  assert.notEqual(seal, approvalSeal("recipient", second, SEED));
  assert.equal(verifyApprovalSeal("recipient", first, seal, SEED), true);
  assert.equal(verifyApprovalSeal("recipient", second, seal, SEED), false);
});

test("the signing path refuses a bad kind, field, nonce or seed", () => {
  const fields = sample("live");
  assert.throws(() => approvalSeal("go-live", fields, SEED), { code: "bad_seal_kind" });
  assert.throws(() => approvalSeal("", fields, SEED), { code: "bad_seal_kind" });
  assert.throws(() => approvalSeal(null, fields, SEED), { code: "bad_seal_kind" });
  assert.throws(() => approvalSeal("live", null, SEED), { code: "bad_seal_field" });
  assert.throws(() => approvalSeal("live", [], SEED), { code: "bad_seal_field" });
  assert.throws(() => approvalSeal("live", { ...fields, cron: null }, SEED), { code: "bad_seal_field" });
  assert.throws(() => approvalSeal("live", { ...fields, cron: undefined }, SEED), { code: "bad_seal_field" });
  assert.throws(() => approvalSeal("live", { ...fields, rev: Number.NaN }, SEED), { code: "bad_seal_field" });
  assert.throws(() => approvalSeal("live", { ...fields, rev: Number.POSITIVE_INFINITY }, SEED),
    { code: "bad_seal_field" });
  assert.throws(() => approvalSeal("live", { ...fields, tz: { name: "UTC" } }, SEED),
    { code: "bad_seal_field" });
  assert.throws(() => approvalSeal("live", { ...fields, commentVisibility: ["own"] }, SEED),
    { code: "bad_seal_field" });
  assert.throws(() => approvalSeal("live", { ...fields, nonce: undefined }, SEED),
    { code: "bad_seal_field" });
  for (const badNonce of ["", "0F".repeat(16), "0".repeat(31), "0".repeat(33), "z".repeat(32),
    "0".repeat(31) + "G", ` ${"0".repeat(31)}`]) {
    assert.throws(() => approvalSeal("live", { ...fields, nonce: badNonce }, SEED),
      { code: "bad_seal_field" }, `nonce ${JSON.stringify(badNonce)} is refused`);
  }
  assert.throws(() => approvalSeal("live", fields, null), { code: "bad_seal_seed" });
  assert.throws(() => approvalSeal("live", fields, Buffer.alloc(0)), { code: "bad_seal_seed" });
  assert.throws(() => approvalSeal("live", fields, "not a buffer"), { code: "bad_seal_seed" });
});

test("verify never throws, whatever it is handed", () => {
  const fields = sample("credential");
  const seal = approvalSeal("credential", fields, SEED);
  const seals = [null, undefined, 0, 42, {}, [], "", "zz", seal, seal.toUpperCase(), Buffer.from(seal, "hex")];
  const fieldSets = [null, undefined, "x", 42, [], {}, { nonce: "nope" }, { ...fields, nonce: undefined },
    { ...fields, credentialRef: null }, sample("credential")];
  const kinds = [...APPROVAL_KINDS, null, undefined, "", "nope", 42, {}];
  const seeds = [SEED, null, undefined, Buffer.alloc(0), "seed", 42];
  for (const kind of kinds) {
    for (const candidate of fieldSets) {
      for (const candidateSeal of seals) {
        for (const seed of seeds) {
          assert.doesNotThrow(() => {
            const answer = verifyApprovalSeal(kind, candidate, candidateSeal, seed);
            assert.equal(typeof answer, "boolean");
          });
        }
      }
    }
  }
});