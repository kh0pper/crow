/**
 * Preload (`node --import`) for REAL gateway children that run the sharing
 * runtime (tests/fixtures/peer-pair.mjs sync legs). With instance sync on,
 * the gateway's PeerManager.start() builds `new Hyperswarm()`, whose DHT
 * bootstraps against the public nodes at once, even with no topic joined.
 * A test child must never do that.
 *
 * This swaps the `hyperdht` export (in the require cache of the tree the
 * child runs from, before anything loads it) for a subclass with no bootstrap
 * nodes, bound on 127.0.0.1: an isolated DHT that sends nothing anywhere. No
 * sync leg needs Hyperswarm (CROW_INSTANCE_SYNC_HYPERSWARM=0 on every child);
 * contacts never join a topic here either. A guard on dht-rpc's bootstrap
 * prints `[gateway-local-dht-guard]` and throws if any DHT still has a
 * bootstrap node or a non-loopback host, so a mistake is loud.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

const GUARD = "[gateway-local-dht-guard]";
const treeRequire = createRequire(join(process.cwd(), "package.json"));
const dhtPath = treeRequire.resolve("hyperdht");
const HyperDHT = treeRequire("hyperdht");
const DhtRpc = createRequire(dhtPath)("dht-rpc");

class LocalOnlyDHT extends HyperDHT {
  constructor(opts = {}) {
    super({ ...opts, bootstrap: [], host: "127.0.0.1" });
  }
}
treeRequire.cache[dhtPath].exports = LocalOnlyDHT;

const realBootstrap = DhtRpc.prototype._bootstrap;
DhtRpc.prototype._bootstrap = function guardedBootstrap() {
  const nodes = this.bootstrapNodes || [];
  if (nodes.length > 0 || this.io?._host !== "127.0.0.1") {
    console.error(`${GUARD} refused a DHT with bootstrap ${JSON.stringify(nodes)} on host ${this.io?._host}`);
    throw new Error("gateway-local-dht guard: a test gateway's DHT must have no bootstrap nodes and bind 127.0.0.1");
  }
  return realBootstrap.call(this);
};
console.log(`${GUARD.replace("-guard", "")} active: isolated loopback DHT, no bootstrap`);
