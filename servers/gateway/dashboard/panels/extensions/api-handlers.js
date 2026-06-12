/**
 * Extensions Panel — POST API Handlers
 *
 * Handles add_store and remove_store POST actions for community store management.
 */

import { getStores, saveStores } from "./data-queries.js";

/**
 * Handle POST requests for the extensions panel.
 * Returns true if the request was handled (response sent), false otherwise.
 */
export async function handleExtensionsPost(req, res) {
  if (req.method !== "POST" || !req.body) return false;

  const { action, store_url } = req.body;
  if (action === "add_store" && store_url) {
    const stores = getStores();
    if (!stores.find((s) => s.url === store_url)) {
      stores.push({ url: store_url, addedAt: new Date().toISOString() });
      saveStores(stores);
    }
    return res.redirectAfterPost("/dashboard/extensions");
  }
  if (action === "remove_store" && store_url) {
    const stores = getStores().filter((s) => s.url !== store_url);
    saveStores(stores);
    return res.redirectAfterPost("/dashboard/extensions");
  }
  return false;
}
