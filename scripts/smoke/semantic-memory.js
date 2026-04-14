#!/usr/bin/env node
/**
 * Phase 4 smoke: embedding roundtrip + cosine ranking + reranker.
 *
 * Usage: node scripts/smoke/semantic-memory.js
 */

import { embedText, embedProviderInfo, cosineSim, rankByCosine, vecToBlob, blobToVec } from "../../servers/memory/embeddings.js";
import { rerank } from "../../servers/memory/rerank.js";

function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }

// 1. Provider info
const info = await embedProviderInfo();
if (!info.ok) fail(`embed provider down: ${info.error}`);
console.log(`  provider=${info.provider} model=${info.model} baseUrl=${info.baseUrl}`);

// 2. Embed single + batch
const single = await embedText("the crow orchestrator dispatches multi-agent work");
if (!(single instanceof Float32Array) || single.length !== 1024) fail(`single embed bad shape: len=${single?.length}`);
console.log(`  single embed: dim=${single.length}, |v|=${Math.sqrt(single.reduce((s, x) => s + x*x, 0)).toFixed(3)}`);

const batch = await embedText([
  "Crow runs multi-agent orchestration across Strix Halo and Blackwell GPUs",
  "cats are cute furry animals that sleep a lot",
  "vLLM serves embedding models with OpenAI-compatible /v1/embeddings",
]);
if (batch.length !== 3) fail(`batch embed len mismatch: ${batch.length}`);
console.log(`  batch embed: ${batch.length} items`);

// 3. Cosine similarity — related docs beat unrelated
const query = await embedText("orchestration with vLLM");
const scores = batch.map((v, i) => ({ idx: i, score: cosineSim(query, v) }));
scores.sort((a,b) => b.score - a.score);
console.log("  cosine scores (vs 'orchestration with vLLM'):");
for (const s of scores) console.log(`    ${s.score.toFixed(3)}  idx=${s.idx}`);
if (scores[0].idx === 1) fail("cat doc should not rank highest on 'orchestration with vLLM' query");

// 4. BLOB roundtrip
const blob = vecToBlob(single);
const roundtrip = blobToVec(blob);
if (cosineSim(single, roundtrip) < 0.9999) fail("BLOB roundtrip lost precision");
console.log(`  BLOB roundtrip: ${blob.length} bytes, cosine=1.0 (exact)`);

// 5. rankByCosine
const candidates = batch.map((v, i) => ({ id: i, text: ["orch", "cats", "vllm"][i], vec: v }));
const top = rankByCosine(query, candidates, 2);
console.log(`  rankByCosine top-2:  [${top.map(t => `#${t.id}(${t.score.toFixed(3)})`).join(", ")}]`);

// 6. Reranker
const rerankCandidates = [
  { id: 0, text: "Crow runs multi-agent orchestration across Strix Halo and Blackwell GPUs" },
  { id: 1, text: "cats are cute furry animals that sleep a lot" },
  { id: 2, text: "vLLM serves embedding models with OpenAI-compatible /v1/embeddings" },
];
const rr = await rerank("orchestration with vLLM", rerankCandidates, { topK: 2 });
console.log(`  reranker top-2: [${rr.map(r => `#${r.id}(${(r.relevance ?? -1).toFixed(3)})`).join(", ")}]`);
if (rr[0].id === 1) fail("reranker should not put cats first");

console.log("\nPASS: all semantic-memory assertions passed");
