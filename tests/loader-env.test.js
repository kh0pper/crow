/**
 * The loader/injection env name rule (servers/shared/loader-env.js) — one leaf module read
 * by the manifest contract and by routes/bundles.js at entry-build time. These tests pin the
 * list, the case-insensitive match, the prefix families, and the import-free shape that lets
 * a boot path and a CLI script both load it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LOADER_ENV_EXACT,
  LOADER_ENV_PREFIXES,
  isLoaderEnvName,
  withoutLoaderEnv,
} from "../servers/shared/loader-env.js";

const MODULE_PATH = new URL("../servers/shared/loader-env.js", import.meta.url);

test("every exact name is a loader name, upper and lower case", () => {
  for (const name of LOADER_ENV_EXACT) {
    assert.equal(isLoaderEnvName(name), true, name);
    assert.equal(isLoaderEnvName(name.toLowerCase()), true, name.toLowerCase());
  }
  // The list itself, so a name cannot quietly disappear from it.
  assert.deepEqual([...LOADER_ENV_EXACT], [
    "NODE_OPTIONS",
    "NODE_PATH",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PYTHONHOME",
    "PYTHONUSERBASE",
    "PERL5OPT",
    "PERL5LIB",
    "RUBYOPT",
    "RUBYLIB",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "BASH_ENV",
    "ENV",
    "GCONV_PATH",
  ]);
});

test("the LD_ and DYLD_ families are loader names", () => {
  assert.deepEqual([...LOADER_ENV_PREFIXES], ["LD_", "DYLD_"]);
  assert.equal(isLoaderEnvName("LD_PRELOAD"), true);
  assert.equal(isLoaderEnvName("ld_library_path"), true);
  assert.equal(isLoaderEnvName("DYLD_INSERT_LIBRARIES"), true);
  assert.equal(isLoaderEnvName("LD_AUDIT"), true);
  // Prefix match is on the whole upper-cased name, not a trimmed or substring match.
  assert.equal(isLoaderEnvName(" LD_PRELOAD"), false);
});

test("ordinary environment names are not loader names", () => {
  for (const name of ["PATH", "HOME", "NODE_ENV", "LDAP_URI", "ENVIRONMENT", "ENV_FILE", "PWD"]) {
    assert.equal(isLoaderEnvName(name), false, name);
  }
});

test("a non-string is never a loader name", () => {
  for (const value of [undefined, null, 42, true, {}, [], Symbol("NODE_OPTIONS")]) {
    assert.equal(isLoaderEnvName(value), false, String(value));
  }
});

test("both lists are frozen", () => {
  assert.equal(Object.isFrozen(LOADER_ENV_EXACT), true);
  assert.equal(Object.isFrozen(LOADER_ENV_PREFIXES), true);
  assert.throws(() => { LOADER_ENV_EXACT.push("X"); }, TypeError);
  assert.throws(() => { LOADER_ENV_PREFIXES.push("X"); }, TypeError);
});

test("withoutLoaderEnv strips loader names and copies everything else", () => {
  const input = {
    PATH: "/usr/bin",
    NODE_OPTIONS: "--require /tmp/evil.js",
    ld_preload: "/tmp/evil.so",
    DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
    HOME: "/home/alex",
    GCONV_PATH: "/tmp/gconv",
  };
  const out = withoutLoaderEnv(input);
  assert.deepEqual(out, { PATH: "/usr/bin", HOME: "/home/alex" });
  // A new object: the input is untouched, and the result is not the input.
  assert.notEqual(out, input);
  assert.deepEqual(Object.keys(input).sort(), ["DYLD_INSERT_LIBRARIES", "GCONV_PATH", "HOME", "ld_preload", "NODE_OPTIONS", "PATH"].sort());
});

test("withoutLoaderEnv returns {} for null, undefined and non-objects", () => {
  for (const value of [null, undefined, 42, "PATH=/usr/bin", true]) {
    assert.deepEqual(withoutLoaderEnv(value), {}, String(value));
  }
  assert.deepEqual(withoutLoaderEnv({}), {});
});

test("the module has no import statements", () => {
  const src = readFileSync(MODULE_PATH, "utf8");
  assert.equal(/^\s*import\s/m.test(src), false, "servers/shared/loader-env.js must stay import-free");
});