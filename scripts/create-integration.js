#!/usr/bin/env node

/**
 * Integration Scaffolding CLI
 *
 * Interactive tool that generates boilerplate for a new Crow integration.
 * Outputs code snippets to console — does NOT modify any files.
 *
 * Usage: npm run create-integration
 */

import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
  console.log("\n🐦 Crow Integration Scaffolding\n");
  console.log("This tool generates code snippets for a new integration.");
  console.log("It does NOT modify any files — copy the output where indicated.\n");

  const serviceName = await ask("Service name (e.g., Linear): ");
  const serviceId = serviceName.toLowerCase().replace(/\s+/g, "-");
  const npmPackage = await ask(`npm package (e.g., @anthropic/mcp-server-${serviceId}): `);
  const envVarPrefix = serviceId.toUpperCase().replace(/-/g, "_");
  const envVarName = await ask(`Primary env var name (default: ${envVarPrefix}_API_KEY): `) || `${envVarPrefix}_API_KEY`;
  const keyUrl = await ask("API key URL (where users get their key): ");

  console.log("\n" + "=".repeat(60));
  console.log("GENERATED SCAFFOLDING");
  console.log("=".repeat(60));

  // 1. integrations.js entry
  console.log("\n--- 1. Add to servers/gateway/integrations.js ---\n");
  console.log(`{
  id: "${serviceId}",
  name: "${serviceName}",
  description: "Connect to ${serviceName}",
  npmPackage: "${npmPackage}",
  envVars: [
    {
      name: "${envVarName}",
      description: "API key from ${serviceName}",
      helpUrl: "${keyUrl}"
    }
  ],
  command: "npx",
  args: ["-y", "${npmPackage}"],
}`);

  // 2. Add to server registry
  console.log("\n--- 2. Add to scripts/server-registry.js EXTERNAL_SERVERS ---\n");
  console.log(`{
  name: "${serviceId}",
  command: "npx",
  args: ["-y", "${npmPackage}"],
  envKeys: ["${envVarName}"],
  envMap: { ${envVarName}: "${envVarName}" },
  mcpEnv: { ${envVarName}: "\${${envVarName}}" },
  description: "Requires ${envVarName}",
  category: "productivity",
}`);
  console.log("\nThen run 'npm run mcp-config' to regenerate .mcp.json.");

  // 3. .env.example
  console.log("\n--- 3. Add to .env.example ---\n");
  console.log(`${envVarName}=         # From ${keyUrl}`);

  // 4. Skill file
  console.log(`\n--- 4. Create skills/${serviceId}.md ---\n`);
  console.log(`# ${serviceName} Skill

## Description
Interact with ${serviceName} through the ${serviceName} MCP server.

## When to Use
- When the user mentions "${serviceId}" or related keywords
- When managing ${serviceName} resources

## Tools Available
The ${serviceName} MCP server provides:
- **tool_1** — Description
- **tool_2** — Description

## Workflow: Main Use Case
1. Identify what the user wants to do with ${serviceName}
2. Call the appropriate tool
3. Store relevant results in memory with \`crow_store_memory\`

## Best Practices
- Ensure ${envVarName} is configured
- Store important ${serviceName} data in memory for cross-session access`);

  // 5. Trigger row
  console.log("\n--- 5. Add to skills/superpowers.md trigger table ---\n");
  console.log(`| "${serviceId}", "keyword" | "${serviceId}", "palabra clave" | ${serviceId} | ${serviceId} |`);

  console.log("\n" + "=".repeat(60));
  console.log("Done! Copy each section to the indicated file.");
  console.log("=".repeat(60) + "\n");

  rl.close();
}

main().catch((err) => {
  console.error("Error:", err.message);
  rl.close();
  process.exit(1);
});
