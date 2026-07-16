/**
 * Citation date rendering must be timezone-safe.
 *
 * publication_date is free-form TEXT ("1993", "2005-07", "2023-05-14").
 * new Date() parses those ISO date-only forms as UTC MIDNIGHT, and
 * getFullYear()/toLocaleDateString() then read them in the server's local
 * zone — so west of UTC every bare year rendered as year − 1 ("1993" →
 * "(1992)") and full dates as the previous day. Found 2026-07-15 by the
 * rookery Task-6 audit loop: 10/14 bibliography entries wrong, and
 * crow_get_source's regenerated citations misled a blind audit twice.
 *
 * Affected paths all funnel through the generators: crow_add_source
 * auto-APA, crow_generate_bibliography, crow_get_source citations.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// The bug only shows west of UTC; pin the zone so the test is
// deterministic on any machine (Node re-reads TZ per Date call on Linux).
process.env.TZ = "America/Chicago";

const { generateAPA, generateMLA, generateChicago } = await import(
  "../servers/research/server.js"
);

const base = {
  authors: "Cortez, A.",
  title: "School finance in Texas",
  publisher: "IDRA",
  source_type: "academic_paper",
};

test("APA: bare-year publication_date keeps its year", () => {
  const apa = generateAPA({ ...base, publication_date: "1993" });
  assert.match(apa, /\(1993\)/, `got: ${apa}`);
});

test("APA: full-date publication_date keeps its year", () => {
  const apa = generateAPA({ ...base, publication_date: "2023-05-14" });
  assert.match(apa, /\(2023\)/, `got: ${apa}`);
});

test("APA: missing publication_date renders (n.d.)", () => {
  const apa = generateAPA({ ...base, publication_date: null });
  assert.match(apa, /\(n\.d\.\)/, `got: ${apa}`);
});

test("Chicago: bare-year book keeps its year", () => {
  const chi = generateChicago({
    ...base,
    source_type: "book",
    publication_date: "1993",
  });
  assert.match(chi, /1993/, `got: ${chi}`);
  assert.doesNotMatch(chi, /1992/, `got: ${chi}`);
});

test("MLA: full date renders the stored day, not the previous day", () => {
  const mla = generateMLA({
    ...base,
    source_type: "web_article",
    url: "https://example.org",
    publication_date: "2023-05-14",
  });
  assert.match(mla, /May 14, 2023/, `got: ${mla}`);
});

test("MLA: bare year renders as the year alone, not December 31 of year − 1", () => {
  const mla = generateMLA({
    ...base,
    source_type: "web_article",
    url: "https://example.org",
    publication_date: "1993",
  });
  assert.match(mla, /1993/, `got: ${mla}`);
  assert.doesNotMatch(mla, /December 31, 1992/, `got: ${mla}`);
});

test("MLA: year-month renders month + year", () => {
  const mla = generateMLA({
    ...base,
    source_type: "web_article",
    url: "https://example.org",
    publication_date: "2005-07",
  });
  assert.match(mla, /July 2005/, `got: ${mla}`);
});

test("Chicago: non-ISO date string still renders via Date fallback", () => {
  const chi = generateChicago({
    ...base,
    source_type: "web_article",
    url: "https://example.org",
    publication_date: "May 14, 2023",
  });
  assert.match(chi, /May 14, 2023/, `got: ${chi}`);
});
