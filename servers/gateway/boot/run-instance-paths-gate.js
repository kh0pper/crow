/**
 * Side-effect module: applies the checkout .env and runs the instance-path
 * gate (./instance-paths-gate.js). servers/gateway/index.js imports this
 * FIRST — keep it first, so every other module is evaluated after it.
 */
// A satellite host (CROW_PROFILE=satellite) is refused (exit 78) before the .env or the gate.
import "./satellite-profile-guard.js";
import { runInstancePathsGate } from "./instance-paths-gate.js";

runInstancePathsGate();
