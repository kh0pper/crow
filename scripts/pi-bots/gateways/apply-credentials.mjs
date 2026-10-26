/**
 * Side-effect module: applies systemd credentials (servers/shared/credentials-env.js)
 * to process.env. gateway_runner.mjs imports it FIRST, so every module in the
 * runner's import graph that reads env at import time sees the credential
 * values (the gateway does the same through boot/run-instance-paths-gate.js).
 */
import { applyCredentialFiles } from "../../../servers/shared/credentials-env.js";

applyCredentialFiles(process.env);
