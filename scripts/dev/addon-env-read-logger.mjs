/**
 * Dev/test only: report a read of an environment key an add-on was not given.
 *
 * The allowlist of a gateway-spawned add-on is an explicit one (see
 * servers/gateway/addon-env.js), so a key whose value used to arrive by
 * inheritance simply reads as undefined now. This preload makes those reads
 * visible while an add-on is developed or a suite runs:
 *
 *   CROW_ADDON_ENV_ALLOW="PATH,HOME,LANG,..." \
 *     node --import ./scripts/dev/addon-env-read-logger.mjs .../server/index.js
 *
 * For each key read that is not in CROW_ADDON_ENV_ALLOW (a comma list), one
 * line on stderr: `[addon-env] read of undeclared <KEY>`. Never a value.
 * `process.env` is wrapped, not replaced: writes and reads still reach the real
 * environment, and a child process inherits it unchanged.
 *
 * Not loaded in production — nothing imports it.
 */
const allow = new Set(
  String(process.env.CROW_ADDON_ENV_ALLOW || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Only names that look like environment keys are interesting (not `inspect`, not symbols). */
const KEY = /^[A-Z_][A-Z0-9_]*$/;
const reported = new Set();
const realEnv = process.env;

function report(key) {
  if (reported.has(key)) return;
  reported.add(key);
  process.stderr.write(`[addon-env] read of undeclared ${key}\n`);
}

const wrapped = new Proxy(realEnv, {
  get(target, prop, receiver) {
    if (typeof prop === "string" && KEY.test(prop) && !allow.has(prop)) report(prop);
    return Reflect.get(target, prop, receiver);
  },
  has(target, prop) {
    if (typeof prop === "string" && KEY.test(prop) && !allow.has(prop) && !(prop in target)) report(prop);
    return Reflect.has(target, prop);
  },
});

Object.defineProperty(process, "env", {
  configurable: true,
  enumerable: true,
  get: () => wrapped,
  set: (value) => {
    for (const key of Object.keys(realEnv)) delete realEnv[key];
    Object.assign(realEnv, value || {});
  },
});