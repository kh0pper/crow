// Crow Artifacts — default limits (spec §4.3, §7.3, §7.4, §9.1; D17: accepted
// as written, settings later). One place, so the settings work only has to
// change how these are read.
export const LIMITS = Object.seal({
  versionBytes: 50 * 1024 * 1024,
  instanceBytes: 2 * 1024 * 1024 * 1024,
  versionsKept: 20,
  filesPerVersion: 2000,
  inboundPerContactBytes: 500 * 1024 * 1024,
  acceptOverBytes: 10 * 1024 * 1024,
  commentChars: 4000,
  openThreadsPerContactPerArtifact: 20,
  commentsPerContactPerHour: 30,
  roundTimeoutMs: 30 * 60 * 1000,
  askTimeoutMs: 10 * 60 * 1000,
  viewTokenMs: 30 * 60 * 1000,
  anchorJsonBytes: 4096,
  // Self-review bounds (not D17 numbers): unbounded work per artifact / round.
  threadsPerArtifact: 500,
  threadsPerRound: 50,
  botCommentsPerHour: 120,
  roundMessageChars: 200000,
  // Not a D17 number: marked has a cliff on long escape-dense input and the
  // document type renders in the gateway process (renderer.js BOT_MD_MAX_INPUT).
  documentMarkdownBytes: 256 * 1024,
  titleChars: 200,
  changeNoteChars: 2000,
  summaryChars: 4000,
});

const DEFAULTS = Object.freeze({ ...LIMITS });
/** Test seam: override some limits; returns a restore function. */
export function _overrideLimitsForTest(o) {
  Object.assign(LIMITS, o);
  return () => Object.assign(LIMITS, DEFAULTS);
}
