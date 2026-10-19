/**
 * Side-effect module: applies the checkout .env and runs the instance-path
 * gate (./instance-paths-gate.js). servers/gateway/index.js imports this
 * FIRST — keep it first, so every other module is evaluated after it.
 */
import { runInstancePathsGate } from "./instance-paths-gate.js";

runInstancePathsGate();
