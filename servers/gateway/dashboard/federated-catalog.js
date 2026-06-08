/**
 * Merge the local catalog with peer catalogs into a mesh view (F4a Layer 1).
 * Mirrors the mergeDiscoveredPeers spirit: local items are tagged with the
 * local instance; each peer's items are tagged with that peer's id/name and
 * remote:true. An unavailable peer (status !== "ok") simply contributes
 * nothing — never throws, never blocks.
 */
function tag(items, instance, instanceName, remote) {
  return (Array.isArray(items) ? items : []).map((it) => ({ ...it, instance, instanceName, remote }));
}

export function mergeFederatedCatalog(localCatalog, peerCatalogs, localId) {
  const lc = localCatalog || { tools: [], skills: [], bots: [] };
  const out = {
    tools: tag(lc.tools, localId, lc.instanceName || null, false),
    skills: tag(lc.skills, localId, lc.instanceName || null, false),
    bots: tag(lc.bots, localId, lc.instanceName || null, false),
  };
  for (const peer of (Array.isArray(peerCatalogs) ? peerCatalogs : [])) {
    if (!peer || peer.status !== "ok" || !peer.capabilities) continue;
    const id = peer.instanceId || (peer.instance && peer.instance.id);
    const name = (peer.instance && peer.instance.name) || null;
    out.tools.push(...tag(peer.capabilities.tools, id, name, true));
    out.skills.push(...tag(peer.capabilities.skills, id, name, true));
    out.bots.push(...tag(peer.capabilities.bots, id, name, true));
  }
  return out;
}
