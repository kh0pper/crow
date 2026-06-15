/**
 * v1 Fix-it remedy (instant): add a capability to THIS instance's local
 * `remote_exposed_tools` allowlist so trusted peers may invoke it. Only ever
 * ADDS to this instance's own local setting — no cross-instance write, no sync.
 */
import { getExposedCapabilities } from "../../peer-exposure.js";
import { writeSetting } from "../../dashboard/settings/registry.js";

export default async function exposeCapability(args, ctx) {
  const capability = args && typeof args.capability === "string" ? args.capability.trim() : "";
  if (!capability) return { resolved: false, message: "No capability specified." };
  const db = ctx.db;
  const exposed = await getExposedCapabilities(db); // Set<string>, deny-all on error
  exposed.add(capability);
  await writeSetting(db, "remote_exposed_tools", JSON.stringify([...exposed]), { scope: "local" });
  console.log(`[fix-it] exposed capability "${capability}" to trusted peers (local scope)`);
  return { resolved: true, message: `${capability} is now shared with your trusted devices.` };
}
