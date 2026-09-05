// tests/model-catalog-launch-parity.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeLaunch, renderLaunchArgs } from "../servers/gateway/models/launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, "..", "registry", "model-catalog.json"), "utf8"));
const fixturesDir = join(here, "fixtures", "launch-parity");

// Flags the orchestrator owns outside the launch block (identity, companions, task).
const IDENTITY = new Set(["-m", "--model", "--mmproj", "--alias", "--host", "--port", "--embedding", "--embeddings", "--reranking"]);
const ALIASES = { "--parallel": "-np", "--ctx-size": "-c", "--n-gpu-layers": "-ngl", "--flash-attn": "-fa", "--embeddings": "--embedding" };
const BOOLEAN_FLAGS = new Set(["--no-mmap", "--jinja", "--embedding", "--embeddings", "--reranking"]);

/** argv -> Map<flag, value|true>, aliases normalized, identity flags dropped. */
function flagPairs(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i];
    if (!flag.startsWith("-")) continue;
    flag = ALIASES[flag] || flag;
    const isBool = BOOLEAN_FLAGS.has(flag) || i + 1 >= argv.length || argv[i + 1].startsWith("-");
    const value = isBool ? true : argv[++i];
    if (IDENTITY.has(flag)) continue;
    out.set(flag, value);
  }
  return out;
}

for (const file of readdirSync(fixturesDir).filter((f) => f.endsWith(".json"))) {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
  test(`launch parity: ${fixture.catalogId} renders every flag its retired compose carried (${fixture.source})`, () => {
    const model = catalog.models.find((m) => m.id === fixture.catalogId);
    assert.ok(model, `catalog has ${fixture.catalogId}`);
    const jinja = fixture.command.includes("--jinja") || !!model.chat_template_kwargs;
    const rendered = renderLaunchArgs(mergeLaunch(model.launch, jinja ? { jinja: true } : null));
    const want = flagPairs(fixture.command);
    const got = flagPairs(rendered);
    for (const [flag, value] of want) {
      assert.ok(got.has(flag), `${fixture.catalogId}: catalog launch is missing ${flag}`);
      assert.equal(got.get(flag), value, `${fixture.catalogId}: ${flag} differs`);
    }
    for (const flag of got.keys()) {
      assert.ok(want.has(flag), `${fixture.catalogId}: catalog launch adds ${flag} the compose never had`);
    }
  });
}
