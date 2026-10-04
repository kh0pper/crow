import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeNumber, checkNumberPolicy, validatePlan, planHash, OUTCOMES } from "../bundles/phone/server/plan.js";

test("normalizeNumber accepts common US formats", () => {
  assert.equal(normalizeNumber("(512) 555-0100"), "+15125550100");
  assert.equal(normalizeNumber("+1 512.555.0100"), "+15125550100");
  assert.equal(normalizeNumber("15125550100"), "+15125550100");
});

test("normalizeNumber rejects MMI/star codes, short and non-NANP numbers", () => {
  for (const bad of ["*67 512 555 0100", "**21*5125550100#", "911", "+44 20 7946 0958", "512-555-010", "5125550100;", "5125550100,123"]) {
    assert.throws(() => normalizeNumber(bad), (e) => e.code === "invalid_number", bad);
  }
});

test("checkNumberPolicy blocks N11 codes, 900/976, the owner's number, suppressed numbers", () => {
  const block = (n, opts = {}) => assert.throws(() => checkNumberPolicy(n, opts), (e) => e.code === "number_blocked", n);
  block("+19115550100");            // N11 area code
  block("+15129115555");            // N11 exchange
  block("+19005550123");            // 900 area code
  block("+15129765555");            // 976 exchange
  block("+15125550100", { ownerNumber: "+15125550100" });
  block("+15125550199", { suppressed: new Set(["+15125550199"]) });
  checkNumberPolicy("+15125550101", { ownerNumber: "+15125550100", suppressed: new Set() });
});

test("checkNumberPolicy rejects non-normalized E.164 input", () => {
  const block = (n, opts = {}) => assert.throws(() => checkNumberPolicy(n, opts), (e) => e.code === "number_blocked" && e.reason === "not_e164", n);
  block("5129115555");              // Missing +1 prefix
  block("+5129115555");             // Missing 1 prefix
});

test("checkNumberPolicy normalizes ownerNumber and blocks on match", () => {
  // Formatted ownerNumber should be normalized and still block the matching E.164
  assert.throws(() => checkNumberPolicy("+15125550100", { ownerNumber: "(512) 555-0100" }),
    (e) => e.code === "number_blocked" && e.reason === "owner_number");
  // Invalid ownerNumber should be ignored, not throw
  checkNumberPolicy("+15125550101", { ownerNumber: "invalid" });
});

test("checkNumberPolicy blocks 900 exchange", () => {
  assert.throws(() => checkNumberPolicy("+15129005555"), (e) => e.code === "number_blocked" && e.reason === "premium");
});

const base = {
  business_name: "Smile Dental", number: "512-555-0101", goal: "Book a cleaning",
  limits: { date_range: { from: "2026-10-05", to: "2026-10-16" }, days_of_week: ["mon","tue","wed","thu","fri"],
            time_window: { start: "15:00", end: "18:00", tz: "America/Chicago" }, max_price: { amount: 150, currency: "USD" } },
  shareable: { name: "Casey Rivers", callback_number: "512-555-0100" },
  language: "en",
};

test("validatePlan normalizes and keeps only allowed shareable fields", () => {
  const p = validatePlan({ ...base, shareable: { ...base.shareable, ssn: "123-45-6789" } });
  assert.equal(p.number_e164, "+15125550101");
  assert.deepEqual(Object.keys(p.shareable).sort(), ["callback_number", "name"]);
  assert.equal(p.language, "en");
});

test("validatePlan rejects bad language, inverted ranges, bad times", () => {
  const bad = (patch) => assert.throws(() => validatePlan({ ...base, ...patch }), (e) => e.code === "invalid_plan");
  bad({ language: "fr" });
  bad({ limits: { ...base.limits, date_range: { from: "2026-10-16", to: "2026-10-05" } } });
  bad({ limits: { ...base.limits, time_window: { start: "25:00", end: "18:00", tz: "America/Chicago" } } });
  bad({ goal: "" });
  bad({ business_name: "x".repeat(201) });
});

test("validatePlan rejects null or non-object limits", () => {
  const bad = (patch) => assert.throws(() => validatePlan({ ...base, ...patch }), (e) => e.code === "invalid_plan");
  bad({ limits: null });
  bad({ limits: "string" });
  bad({ limits: 123 });
});

test("planHash is stable and changes when anything material changes", () => {
  const a = validatePlan(base), b = validatePlan({ ...base });
  assert.equal(planHash(a), planHash(b));
  assert.notEqual(planHash(a), planHash(validatePlan({ ...base, goal: "Book two cleanings" })));
});

test("OUTCOMES is the spec list", () => {
  assert.deepEqual(OUTCOMES, ["booked","info_gathered","needs_callback","no_answer","voicemail","busy","not_in_service","refused","phone_busy","phone_unreachable","line_lost","taken_over","not_admissible","stopped","failed"]);
});


test("review M3: a bot-proposed run_after is held to the same strict ISO-8601 check as the owner's", async () => {
  const { validatePlan, parseIsoInstant } = await import("../bundles/phone/server/plan.js");
  const base = { business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en" };
  for (const bad of ["Tue, 6 Oct 2026", "2030-01-01T15:30", "2030-01-01", "2030-02-30T15:30:00Z", 1767225600000]) {
    assert.throws(() => validatePlan({ ...base, run_after: bad }), (e) => e.code === "invalid_plan", String(bad));
  }
  assert.equal(validatePlan({ ...base, run_after: "2030-01-01T09:30:00-06:00" }).run_after, "2030-01-01T15:30:00.000Z");
  assert.equal(validatePlan({ ...base, run_after: "" }).run_after, null, "empty means no proposal");
  assert.equal(parseIsoInstant("2028-02-29T12:00:00Z"), "2028-02-29T12:00:00.000Z");
});
