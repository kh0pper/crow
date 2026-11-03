/**
 * The credential card, Task 4: the Connect card (project services §6.7).
 *
 * A tool result carrying servers/shared/service-connections.js's NOT_CONNECTED_MARKER renders
 * "Connect <service>" in the Perch chat, linking to that project's Services page with the connect
 * sheet open. Runs on the full-script vm harness (tests/fixtures/perch-hub-vm.mjs), the same shape
 * tests/perch-hub-client.test.js uses, so the card is drawn by the emitted client itself.
 *
 * GAP this file also pins: no tool emits the marker yet (the services tool family has not landed).
 * notConnectedResult() is what a tool returns when it does; the client needs no change then.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NOT_CONNECTED_MARKER, notConnectedResult } from "../servers/shared/service-connections.js";
import { mountHub, openChatSession, findByClass, stdFetch, FakeEventSource } from "./fixtures/perch-hub-vm.mjs";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Mount a hub on an open chat and hand one finished tool result to the client. */
async function toolResult(resultText) {
  const hub = await mountHub({ fetchImpl: stdFetch() });
  await openChatSession(hub);
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  es._serverFrame("state", { state: "awake", turnInFlight: true });
  es._serverFrame("tool", { phase: "start", name: "mcp__github__list_repos", toolCallId: "c1" });
  es._serverFrame("tool", { phase: "end", name: "mcp__github__list_repos", toolCallId: "c1", resultText, isError: false });
  await tick();
  return hub;
}

test("the shared marker and helper are one fixed line", () => {
  assert.equal(NOT_CONNECTED_MARKER, "[not connected in this project]");
  const text = notConnectedResult("github", "home");
  assert.ok(text.startsWith(NOT_CONNECTED_MARKER + " "), text);
  assert.ok(text.includes("/dashboard/project/home/services?connect=github"), text);
  // An id the client would refuse to link still yields the honest marker line, with no link.
  const bad = notConnectedResult("Git Hub", "../etc");
  assert.ok(bad.startsWith(NOT_CONNECTED_MARKER + " "), bad);
  assert.ok(!bad.includes("/dashboard/project/"), bad);
});

test("connect card renders and links", async () => {
  const hub = await toolResult(notConnectedResult("github", "home"));
  const card = findByClass(hub.els["perch-transcript"], "connect-card");
  assert.ok(card, "a tool result with the marker renders a card");
  assert.equal(findByClass(card, "connect-title").textContent, "Connect github");
  assert.equal(findByClass(card, "connect-help").textContent,
    "This service isn't connected in this project. Enter its key on the Services page, not in this chat.");
  const a = findByClass(card, "connect-open");
  assert.ok(a, "the card carries the link");
  assert.equal(a.href, "/dashboard/project/home/services?connect=github");
  assert.equal(a.textContent, "Open Services");
});

test("a bad slug renders no connect card", async () => {
  const bad = [
    // The marker with no link at all.
    NOT_CONNECTED_MARKER + " github is not connected in this project.",
    // Uppercase, traversal, and an uppercase service id: each fails ^[a-z0-9][a-z0-9-]{0,63}$.
    NOT_CONNECTED_MARKER + " github is not connected. Connect at /dashboard/project/Home/services?connect=github",
    NOT_CONNECTED_MARKER + " github is not connected. Connect at /dashboard/project/../etc/services?connect=github",
    NOT_CONNECTED_MARKER + " github is not connected. Connect at /dashboard/project/home/services?connect=GitHub",
    NOT_CONNECTED_MARKER + " github is not connected. Connect at /dashboard/project/-home/services?connect=github",
  ];
  for (const text of bad) {
    const hub = await toolResult(text);
    assert.equal(findByClass(hub.els["perch-transcript"], "connect-card"), null, text);
  }
});

test("a result without the marker renders no connect card", async () => {
  const hub = await toolResult("3 repositories found: alpha, beta, gamma");
  assert.equal(findByClass(hub.els["perch-transcript"], "connect-card"), null);
});

test("en and es", async () => {
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  for (const k of ["perch.connectTitle", "perch.connectHelp", "perch.connectOpen"]) {
    const en = t(k, "en"), es = t(k, "es");
    assert.ok(en && en !== k, k + " en");
    assert.ok(es && es !== k && es !== en, k + " es");
  }
  assert.equal(t("perch.connectTitle", "en"), "Connect {service}");
  assert.equal(t("perch.connectTitle", "es"), "Conectar {service}");
});