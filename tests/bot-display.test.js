/**
 * Bot Builder rows (queue item 20, option A) — the pure display helpers the
 * Bot Builder list and the Bot Board share: board state, friendly model
 * names, the one-line purpose and "updated N ago". No DB, no DOM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boardState, friendlyModel, purposeLine, agoText,
} from "../servers/gateway/dashboard/shared/bot-display.js";

const row = (tracker, projectId = null) => ({
  definition: JSON.stringify(tracker === undefined ? {} : { tracker_config: tracker }),
  project_id: projectId,
});

test("boardState: an absent tracker with no project is off (no_project)", () => {
  assert.deepEqual(boardState(row(undefined)), { state: "off", reason: "no_project" });
});

test("boardState: kanban or task-list with a project is on", () => {
  assert.equal(boardState(row({ type: "kanban" }, 7)).state, "on");
  assert.equal(boardState(row({ type: "task-list" }, 7)).state, "on");
  assert.equal(boardState(row(undefined, 7)).state, "on", "an absent type means kanban");
});

test("boardState: type none is off (none), even with a project", () => {
  assert.deepEqual(boardState(row({ type: "none" }, 7)), { state: "off", reason: "none" });
});

test("boardState: custom with a slug is custom; custom without one is off (no_slug)", () => {
  assert.equal(boardState(row({ type: "custom", tracker_slug: "leads" })).state, "custom");
  assert.deepEqual(boardState(row({ type: "custom" })), { state: "off", reason: "no_slug" });
});

test("boardState: accepts an already-parsed definition object", () => {
  assert.equal(boardState({ definition: { tracker_config: { type: "kanban" } }, project_id: 3 }).state, "on");
  assert.deepEqual(boardState({ definition: "not json", project_id: null }), { state: "off", reason: "no_project" });
});

const PROVIDERS = [
  { id: "crow-chat", models: [{ id: "qwen3.6-35b-a3b", name: "Qwen3.6 35B A3B (local, chat)" }, "plain-model"] },
  { id: "zai", models: [{ id: "glm-5.1", name: "Z.AI GLM-5.1" }] },
];

test("friendlyModel: the provider model's name, cut at the first ' ('", () => {
  assert.equal(friendlyModel("crow-chat/qwen3.6-35b-a3b", PROVIDERS), "Qwen3.6 35B A3B");
  assert.equal(friendlyModel("zai/glm-5.1", PROVIDERS), "Z.AI GLM-5.1");
});

test("friendlyModel: falls back to the id after the provider", () => {
  assert.equal(friendlyModel("crow-chat/plain-model", PROVIDERS), "plain-model");
  assert.equal(friendlyModel("crow-voice/qwen3.5-4b", PROVIDERS), "qwen3.5-4b", "unknown provider");
  assert.equal(friendlyModel("crow-voice/qwen3.5-4b", []), "qwen3.5-4b");
  assert.equal(friendlyModel("bare-key", PROVIDERS), "bare-key");
  assert.equal(friendlyModel("", PROVIDERS), "");
  assert.equal(friendlyModel(null, PROVIDERS), "");
});

const gw = (...types) => ({ gateways: types.map((type) => ({ type })) });

test("purposeLine: perch, glasses and companion read as what the bot does; a kept glasses record reads as retired", () => {
  assert.equal(purposeLine(gw("perch"), "en"), "Chats in Perch");
  assert.equal(purposeLine(gw("glasses"), "en"), "Glasses now answer as Crow");
  assert.equal(purposeLine(gw("glasses"), "es"), "Las gafas ahora responden como Crow");
  assert.equal(purposeLine(gw("companion"), "en"), "AI Companion on a display");
  assert.equal(purposeLine(gw("gmail"), "en"), "Answers on Gmail");
  assert.equal(purposeLine(gw("crow-messages"), "en"), "Answers on Crow Messages");
});

test("purposeLine: at most two channels, joined with ' · '", () => {
  assert.equal(purposeLine(gw("perch", "discord", "slack"), "en"), "Chats in Perch · Answers on Discord");
});

test("purposeLine: no channel reads 'Works through its board' only when the board is on", () => {
  assert.equal(purposeLine(gw(), "en", true), "Works through its board");
  assert.equal(purposeLine(gw(), "en", false), "");
  assert.equal(purposeLine({}, "en"), "");
  assert.equal(purposeLine(gw("signal"), "en"), "", "an unknown channel type adds nothing");
});

test("purposeLine: Spanish is translated", () => {
  assert.notEqual(purposeLine(gw("perch"), "es"), purposeLine(gw("perch"), "en"));
  assert.notEqual(purposeLine(gw(), "es", true), purposeLine(gw(), "en", true));
});

const NOW = Date.parse("2026-10-16T12:00:00Z");

test("agoText: minutes, hours, days and months, singular and plural", () => {
  assert.equal(agoText("2026-10-16 11:59:40", NOW, "en"), "updated just now");
  assert.equal(agoText("2026-10-16 11:59:00", NOW, "en"), "updated 1 minute ago");
  assert.equal(agoText("2026-10-16 11:15:00", NOW, "en"), "updated 45 minutes ago");
  assert.equal(agoText("2026-10-16 11:00:00", NOW, "en"), "updated 1 hour ago");
  assert.equal(agoText("2026-10-16 06:00:00", NOW, "en"), "updated 6 hours ago");
  assert.equal(agoText("2026-10-15 12:00:00", NOW, "en"), "updated 1 day ago");
  assert.equal(agoText("2026-10-07 12:00:00", NOW, "en"), "updated 9 days ago");
  assert.equal(agoText("2026-09-10 12:00:00", NOW, "en"), "updated 1 month ago");
  assert.equal(agoText("2026-06-10 12:00:00", NOW, "en"), "updated 4 months ago");
});

test("agoText: Spanish singular and plural", () => {
  assert.equal(agoText("2026-10-15 12:00:00", NOW, "es"), "actualizado hace 1 día");
  assert.equal(agoText("2026-10-07 12:00:00", NOW, "es"), "actualizado hace 9 días");
  assert.equal(agoText("2026-10-16 11:00:00", NOW, "es"), "actualizado hace 1 hora");
  assert.equal(agoText("2026-06-10 12:00:00", NOW, "es"), "actualizado hace 4 meses");
});

test("agoText: SQLite UTC text is read as UTC; empty or bad input gives ''", () => {
  assert.equal(agoText("2026-10-16T11:00:00Z", NOW, "en"), "updated 1 hour ago");
  assert.equal(agoText("", NOW, "en"), "");
  assert.equal(agoText(null, NOW, "en"), "");
  assert.equal(agoText("not a date", NOW, "en"), "");
});

test("agoText takes a key prefix, so the Unassigned lane can say \"added N ago\"", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  assert.equal(agoText("2026-10-14 12:00:00", now, "en", "botboard.added"), "added 2 days ago");
  assert.equal(agoText("2026-10-16 11:59:30", now, "es", "botboard.added"), "añadida ahora mismo");
  assert.equal(agoText("2026-10-14 12:00:00", now, "en"), "updated 2 days ago", "the default stays \"updated\"");
});

test("friendlyModel: a role: ref shows the role's label (core in en/es, custom by its label); unknown stays raw", () => {
  assert.equal(friendlyModel("role:voice", []), "Voice");
  assert.equal(friendlyModel("role:voice", [], { lang: "es" }), "Voz");
  assert.equal(friendlyModel("role:c-coder", [], { customDefs: { "c-coder": { label: "Coder" } } }), "Coder");
  assert.equal(friendlyModel("role:c-coder", []), "role:c-coder", "no def, no label");
  assert.equal(friendlyModel("role:nope", [], { customDefs: {} }), "role:nope");
  assert.equal(friendlyModel("crow-chat/plain-model", PROVIDERS, { lang: "es" }), "plain-model", "raw keys unchanged");
});
