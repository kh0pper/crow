/**
 * The crow mark: the header bird's static geometry, shared by the header
 * tamagotchi and the onboarding Welcome step (design study quick win 4).
 *
 * The mark must carry no id — the header bird owns #crow-tama and its
 * scripts look it up by id, so a second copy with ids would collide.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { crowMarkSvg, CROW_BODY_GROUP } from "../servers/gateway/dashboard/shared/crow-mark.js";
import { tamagotchiHtml } from "../servers/gateway/dashboard/shared/notifications.js";

// The bird's shapes, as the header has drawn them since the tamagotchi shipped.
const SHAPES = [
  '<g class="crow-body-group">',
  '<g class="crow-feet">',
  '<ellipse class="crow-body" cx="24" cy="34" rx="12" ry="10" fill="#0e6b62"/>',
  '<ellipse class="crow-wing" cx="14" cy="33" rx="6" ry="8" fill="#4fbdb0" opacity="0.5" transform-origin="14 33"/>',
  '<circle class="crow-head" cx="24" cy="18" r="9" fill="#0e6b62"/>',
  '<circle class="crow-eye" cx="28" cy="16" r="3" fill="#d9a521"/>',
  '<circle class="crow-pupil" cx="29" cy="16" r="1.5" fill="#22303a"/>',
  '<polygon class="crow-beak" points="33,18 40,20 33,22" fill="#d9a521"/>',
];

test("crowMarkSvg: the header bird's shapes, decorative, no ids", () => {
  const svg = crowMarkSvg({ size: 64 });
  assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"));
  for (const s of SHAPES) assert.ok(svg.includes(s), "shape " + s);
  assert.ok(!/\sid=/.test(svg), "no id attributes");
  assert.ok(svg.includes('aria-hidden="true"') && svg.includes('focusable="false"'));
  assert.ok(svg.includes('class="crow-mark"'));
  assert.ok(svg.includes('width="64"') && svg.includes('height="64"'));
  assert.ok(!/crow-happy|crow-tired|crow-alarmed/.test(svg), "no mood class, so no header animation applies");
});

test("crowMarkSvg: size is an integer or the default", () => {
  assert.ok(crowMarkSvg().includes('width="48"'));
  assert.ok(crowMarkSvg({ size: '"><script>' }).includes('width="48"'));
  assert.ok(!CROW_BODY_GROUP.includes(" id="), "the shared group has no ids");
});

test("the header tamagotchi still draws the same bird, with its ids", () => {
  const html = tamagotchiHtml("en");
  assert.ok(html.includes('<svg class="crow-tama crow-happy" id="crow-tama" viewBox="0 0 48 56" width="42" height="49" aria-hidden="true" focusable="false">'));
  for (const s of SHAPES) assert.ok(html.includes(s), "shape " + s);
  for (const id of ['id="crow-bubble"', 'id="crow-bubble-count"', 'id="crow-exclaim"', 'id="crow-bird-btn"']) {
    assert.ok(html.includes(id), id);
  }
  assert.ok(html.includes(CROW_BODY_GROUP), "the header reuses the shared group");
});
