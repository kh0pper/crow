# Host-neutral defaults for embeddings, rerank and vision (grackle decommission, D1)

**Date:** 2026-09-24 · **Queue:** Crow improvement queue item 6 (grackle decommission), sub-project D1 · **Session:** crow-67

**Status:** decided autonomously under Kevin's standing grant (memory `feedback-autonomous-superpowers-cycles`). Decisions marked **(mine)** are the session's.

## 1. Problem

Kevin is selling grackle (decision of 2026-09-22). Today every Crow instance silently depends on it:

- `servers/memory/embeddings.js`: `FALLBACK_PROVIDER = "grackle-embed"`. Any instance with no `CROW_EMBED_PROVIDER` env and no `dashboard_settings.embed_provider` embeds through grackle's GPU. crow, raven, black-swan and fresh installs all fall in that group; `embed_provider` is not in the sync allowlist, so each instance resolves on its own.
- `servers/memory/rerank.js`: `DEFAULT_PROVIDER = "grackle-rerank"`. grackle's reranker is not running today, and `rerank()` already degrades to "no rerank" when its provider is missing or fails.
- `servers/gateway/ai/smart-router.js`: `DEFAULT_ROUTES.vision = "grackle-vision"`. That row is not running either. `resolveRouteToProvider` already falls through overrides → baked default → profile fallback → `crow-chat`.

A default that names one machine is a product bug, whatever the machine. It is also what makes decommissioning grackle a code problem rather than just a data move.

**Measured 2026-09-24:** crow already serves the same model at `http://100.118.41.122:8004/v1`, the `llamacpp-vulkan-qwen3-embed` container: Qwen3-Embedding-0.6B, Q8_0 GGUF, `--pooling last`, 1024 dimensions. Embedding the same four texts on both servers gave cosine **0.999–0.9993**, where unrelated texts score 0.44. So switching providers needs **no re-embed**. No provider row points at that endpoint today. The disabled `crow-local-122b` row still points at `:8004`, left over from the retired 122B model.

## 2. Design

### D1 (mine): default embed provider resolved by task, not by name

`resolveDefaultProvider()` keeps its order: `CROW_EMBED_PROVIDER` env first, then `dashboard_settings.embed_provider`. The hard-coded third step, `"grackle-embed"`, is replaced by **the first enabled provider whose first model has `task === "embed"`**. "First" means lowest `id` in the providers table, which is already how `loadProvidersFromDb` orders rows (`WHERE disabled = 0 ORDER BY id`). If no such provider exists, it resolves to `null`.

- A pure, exported helper, `pickProviderByTask(providers, task)`, lives in a new small module `servers/shared/provider-task.js`. It takes a `{ id: row }` map, the shape `loadProviders().providers` has, plus a task string. It returns the lowest id whose `models[0].task === task` and that is not disabled, or `null`. Embeddings and rerank both use it.
- To avoid the cold-cache problem the existing code comments on, the fallback reads the providers table directly (enabled rows, `ORDER BY id`) through the same `createDbClient` path `resolveDefaultProvider` already opens for the settings lookup. It then applies `pickProviderByTask`. If the DB is unavailable, it falls back to `loadProviders().providers`.
- `resolveEmbedConfig(providerName)` loses its `= FALLBACK_PROVIDER` default. Every caller already passes the resolved name. Check this during planning and keep a safe default: callers that pass nothing get `await resolveDefaultProvider()`.
- **When nothing resolves:** embedding calls throw `embedding provider not configured` as they do today for a missing row. `crow_search_memories` already degrades semantic search to FTS on embed failure, and the `semantic` tool description is corrected to stop naming grackle.

### D2 (mine): rerank defaults the same way

`rerank(query, candidates, { providerName })`: when `providerName` is not passed, it resolves in order:

1. `CROW_RERANK_PROVIDER` env;
2. `dashboard_settings.rerank_provider`, if set (a new, optional, local, non-synced key; readable but with no UI in this sub-project);
3. `pickProviderByTask(providers, "rerank")`.

If nothing resolves, it returns candidates unreranked, which is today's missing-provider behaviour. The resolution is cached for 30 s like embed's.

### D3 (mine): smart-router vision default

`DEFAULT_ROUTES.vision` becomes `tierDefault("vision", null)`, so `CROW_SMART_ROUTER_VISION` works like the other tiers.

When the baked default is `null`, `resolveRouteToProvider("vision", …)` tries the first enabled provider with an image-capable model before the profile fallback. Image-capable means `models[].input` includes `"image"`, or `task === "vision"`. Otherwise the existing chain is unchanged.

`DEFAULT_ROUTES` stays frozen, and `vision: null` is a legitimate value there. The smoke scripts under `scripts/smoke/` that assert `grackle-vision` or `grackle-embed` are updated to be host-neutral. They are manual scripts, not part of the suite, but they must not encode a host.

### D4 (mine): what stays out of scope

- **Bundle names** such as `vllm-cuda-embed` and the provider ids `grackle-*` are data. Retiring them is D5 (the retire step) of the decommission, not this PR.
- **Ramble's bird roster** ("grackle" is a bird) and comments or history mentioning grackle stay.
- **`embed_provider` stays out of the fleet sync allowlist.** Syncing it would make every instance use crow's endpoint, even a future offline laptop. The task-based fallback plus one synced provider row does the job without making the endpoint universal.

## 3. Operational step after the PR merges (data, not code)

This runs in a registered CROW-SCHEDULE slot. It touches no GPU and no model containers.

1. **On crow,** upsert provider row `crow-embed`: `base_url http://100.118.41.122:8004/v1`, `host local`, `models [{"id":"qwen3-embedding-0.6b","task":"embed","dim":1024,"matryoshkaDims":[1024,768,512,256],"warm":true,"priority":"interactive"}]`, and `bundle_id llamacpp-vulkan-qwen3-embed`, the bundle that owns the container. Do the upsert through the product path (`upsertProvider`), in-process via a one-shot run while the gateway is up only if that path is safe (per memory, never open a live DB from a second libsql client); otherwise through the gateway's providers API. The plan decides which. The row syncs to raven, grackle and black-swan.
2. **On crow,** set `dashboard_settings.embed_provider = crow-embed` explicitly, so crow doesn't depend on id ordering.
3. **On r4** (a separate identity, no sync): add the same `crow-embed` row and set `embed_provider`. Change `crow-r4-gateway.service`'s `CROW_EMBED_PROVIDER=grackle-embed` to `crow-embed`, and `~/.crow-r4/mcp-addons.json` `EMBED_HOST` to `http://100.118.41.122:8004`. Then restart r4.
4. **Disable** the dead `grackle-rerank` and `grackle-vision` rows on crow (synced) and on r4. **Leave `grackle-embed` enabled** until grackle's retirement step. It still works, and with the task-based fallback it no longer wins on any host that has `crow-embed` (`crow-embed` sorts before it).
5. **Verify:**
   - `crow_search_memories` with `semantic: true` returns semantic hits on crow and r4;
   - crow's embed container logs requests coming from both;
   - raven resolves `crow-embed` by fallback;
   - nothing reaches grackle `:9100` (grackle's container log goes quiet).

## 4. Testing

- **`pickProviderByTask`:** lowest id wins; disabled rows are skipped; a model without `task` is ignored; an empty map returns `null`; a non-object returns `null`.
- **`resolveDefaultProvider`:** an env override wins; a `dashboard_settings` override wins over the fallback; with neither, it returns the lowest-id enabled embed-task provider (a scratch DB with `crow-embed` and `grackle-embed` returns `crow-embed`, and with `crow-embed` disabled it returns `grackle-embed`); with no embed-task rows it returns `null`; the literal `grackle-embed` no longer appears in `embeddings.js`.
- **rerank:** with no provider and no rows, candidates come back in their original order; a task-resolved provider is called (stub the fetch); the env override wins.
- **smart-router:** `vision` resolves to an image-capable enabled provider when present, and falls back as before when none exists; `CROW_SMART_ROUTER_VISION` wins; existing smart-router tests stay green.
- **Full suite** through `npm test`, and CI green.
