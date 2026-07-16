#!/usr/bin/env node
// config-gen.mjs — generate openscience.json from env (stdout).
//
// Replaces the entrypoint's former shell heredoc: MCP registration puts
// operator-supplied strings (URLs, bearer tokens) inside JSON, and
// JSON.stringify is injection-safe where shell interpolation is not.
//
// Env consumed (container-internal names; the compose file maps ROOKERY_*):
//   MODEL_BASE_URL   required — OpenAI-compatible endpoint
//   MODEL_ID         default "local-model"
//   MODEL_API_KEY    default "local"
//   MCP_CROW_URL     optional — crow gateway /router/mcp endpoint; http(s)
//                    only. Registered as a REMOTE MCP (D2: remote-HTTP
//                    bypasses upstream's stdio env leak by design — no
//                    process spawn, no process.env spread).
//   MCP_CROW_TOKEN   required when MCP_CROW_URL is set — the crow local MCP
//                    token (dashboard Connect panel). Rides the config's
//                    headers, never the child env (D4).
//
// Verified v1.3.2 schema (plan Task 1b): mcp: record(name →
// {type:"remote", url, headers?, oauth?, enabled?, timeout?}), strict.

const die = (msg) => {
  console.error(`[config-gen] ${msg}`);
  process.exit(1);
};

const env = process.env;
const modelBaseUrl = env.MODEL_BASE_URL || die("MODEL_BASE_URL is required");
const modelId = env.MODEL_ID || "local-model";

const cfg = {
  model: `crow-local/${modelId}`,
  provider: {
    "crow-local": {
      npm: "@ai-sdk/openai-compatible",
      name: "Crow Local",
      options: { baseURL: modelBaseUrl, apiKey: env.MODEL_API_KEY || "local" },
      models: { [modelId]: { name: modelId } },
    },
  },
};

// Two remote-MCP slots, both authed by the same gateway local token:
//   crow     (MCP_CROW_URL)     → the gateway /projects/mcp mount (sources/bib)
//   research (MCP_RESEARCH_URL) → the filtered /tools-rookery/mcp mount
//     (assemble + OpenAlex search; least-privilege — never /router/mcp, whose
//     crow_tools category exposes every connected integration incl. mail).
const crowToken = env.MCP_CROW_TOKEN || "";
const slots = [
  ["crow", env.MCP_CROW_URL || ""],
  ["research", env.MCP_RESEARCH_URL || ""],
];
for (const [name, url] of slots) {
  if (!url) continue;
  const envName = `MCP_${name.toUpperCase()}_URL`;
  let u;
  try {
    u = new URL(url);
  } catch {
    die(`${envName} is not a valid URL: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    die(`${envName} must be http(s), got ${u.protocol}//`);
  }
  if (!crowToken) {
    // Loud skip, not a half-registration: the gateway MCP mounts require a
    // bearer token, and an MCP that 401s inside the app is opaque to debug.
    console.error(
      `[config-gen] WARN: ${envName} set but MCP_CROW_TOKEN missing — ` +
        `"${name}" NOT registered (generate a local MCP token in the crow ` +
        "dashboard Connect panel)",
    );
    continue;
  }
  cfg.mcp = cfg.mcp || {};
  cfg.mcp[name] = {
    type: "remote",
    url,
    enabled: true,
    headers: { Authorization: `Bearer ${crowToken}` },
  };
}

process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
