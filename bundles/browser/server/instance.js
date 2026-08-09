/**
 * Which Crow instance is this browser server bound to?
 *
 * One module, one answer. server.js used to disagree with itself: browser-sessions
 * honored CROW_HOME while browser-exports and browser-downloads hardcoded ~/.crow,
 * so a second instance on the same host wrote its downloads into the primary's
 * directory. Everything instance-scoped resolves here now.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** This instance's home. Falls back to the primary, which is correct only for the primary. */
export function stateRoot() {
  return process.env.CROW_HOME || join(homedir(), ".crow");
}

/** A state directory under this instance's home, e.g. stateDir("browser-downloads"). */
export function stateDir(name) {
  return join(stateRoot(), name);
}

/**
 * The docker container this instance's browser runs in.
 *
 * manifest.json declares CROW_BROWSER_CONTAINER_NAME and r4's addon sets it, but
 * server.js used to hardcode "crow-browser" in all four of its docker calls — one
 * of which is `docker restart`, so a secondary instance restarting "its" browser
 * killed the primary's Chrome and every session logged into it.
 */
export function containerName() {
  return process.env.CROW_BROWSER_CONTAINER_NAME || "crow-browser";
}
