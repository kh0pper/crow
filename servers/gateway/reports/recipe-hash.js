/**
 * A report recipe's two hashes.
 *
 * A recipe is `{blocks: [{type, settings, ...}]}` — an ordered list of block objects. `recipeHash` is
 * the sha256 of the recipe's canonical JSON, so it names one exact recipe: two saves that differ only
 * in key order hash alike, and a reordering of blocks (which can change what a report reads) is a
 * different hash.
 *
 * `sourcesHash` is the narrower hash the go-live seal leans on: the sha256 of the canonical JSON of
 * every block the block registry marks `sourceBearing: true`, whole block objects (settings included),
 * in recipe order. That is what makes a free change (a column heading, a filter, a sort) keep the same
 * sources hash while a change to a source, a custom step, a model-calling block or a reordering of any
 * of them moves it. Fail closed: a block whose type is not in the registry counts as source-bearing,
 * and so does every block when there is no registry at all (the registry lands in a later PR).
 *
 * Canonical JSON: object keys sorted by their code-unit order, array order kept, no whitespace, no
 * trailing comma. Values JSON cannot represent faithfully (a function, `undefined`, a bigint, a
 * non-finite number) are refused rather than quietly dropped or turned into `null`, because a hash
 * over a lossy encoding would say two different recipes are the same one.
 */
import { createHash } from "node:crypto";

/** The block types that call a model. Both are source-bearing: a model sees the report's items. */
export const MODEL_BLOCK_TYPES = Object.freeze(["ai_commentary", "annotate"]);

function fail(code, detail) {
  const err = new Error(detail ? `${code}: ${detail}` : code);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * One value's canonical JSON text. Object keys are sorted, arrays keep their order, primitives are
 * written the way JSON writes them, and nothing a JSON round trip would change is accepted.
 */
function encode(value, path) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw fail("bad_json", path || "value");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      // undefined, function, symbol, bigint: not representable in JSON.
      throw fail("bad_json", path || "value");
  }
  if (Array.isArray(value)) {
    const parts = [];
    for (let i = 0; i < value.length; i += 1) parts.push(encode(value[i], `${path}[${i}]`));
    return `[${parts.join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    const inner = value[key];
    // `undefined` in an object is what JSON.stringify drops; dropping it would make two recipes with
    // different settings hash alike, so it is refused like any other value JSON cannot carry.
    if (inner === undefined) throw fail("bad_json", path ? `${path}.${key}` : key);
    parts.push(`${JSON.stringify(key)}:${encode(inner, path ? `${path}.${key}` : key)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * The canonical JSON text of `value`: stable key order, array order kept, no whitespace.
 *
 * @param {*} value
 * @returns {string}
 * @throws {Error} `code: "bad_json"` when the value has no faithful JSON spelling
 */
export function canonicalJson(value) {
  return encode(value, "");
}

/** A recipe is an object whose `blocks` is an array of objects that each name a string `type`. */
function assertRecipe(recipe) {
  if (recipe == null || typeof recipe !== "object" || Array.isArray(recipe)) {
    throw fail("bad_recipe", "recipe");
  }
  const { blocks } = recipe;
  if (!Array.isArray(blocks)) throw fail("bad_recipe", "blocks");
  blocks.forEach((block, index) => {
    if (block == null || typeof block !== "object" || Array.isArray(block)) {
      throw fail("bad_recipe", `blocks[${index}]`);
    }
    if (typeof block.type !== "string" || !block.type) throw fail("bad_recipe", `blocks[${index}].type`);
  });
  return blocks;
}

/**
 * The sha256 hex of the recipe's canonical JSON: one name for one exact recipe.
 *
 * @param {{blocks: object[]}} recipe
 * @returns {string} 64 lower-case hex characters
 * @throws {Error} `code: "bad_recipe"` for anything that is not a recipe
 */
export function recipeHash(recipe) {
  assertRecipe(recipe);
  return sha256Hex(canonicalJson(recipe));
}

/** Does this registry entry, if any, mean the block reads something the owner approved? Fail closed. */
function isSourceBearing(block, registry, registryGiven) {
  if (!registryGiven) return true;
  // Own keys only, so a block type like "constructor" cannot borrow Object.prototype's entry.
  const entry = Object.hasOwn(registry, block.type) ? registry[block.type] : null;
  if (entry == null || typeof entry !== "object") return true; // an unknown type counts
  return entry.sourceBearing === true;
}

/**
 * The sha256 hex of the canonical JSON of every source-bearing block, whole block objects in recipe
 * order. With no registry (or an empty one) every block counts, so a change to any block moves it.
 *
 * @param {{blocks: object[]}} recipe
 * @param {Record<string, {sourceBearing?: boolean}>|null|undefined} registry block types to entries
 * @returns {string} 64 lower-case hex characters
 * @throws {Error} `code: "bad_recipe"` for anything that is not a recipe
 */
export function sourcesHash(recipe, registry) {
  const blocks = assertRecipe(recipe);
  const registryGiven =
    registry != null && typeof registry === "object" && !Array.isArray(registry)
    && Object.keys(registry).length > 0;
  const bearing = blocks.filter((block) => isSourceBearing(block, registry, registryGiven));
  return sha256Hex(canonicalJson(bearing));
}

/**
 * Does this recipe ask a model to read the report's items? True when the AI commentary switch is on
 * (1 or true) or when any block is a model-calling type. The switch is the only thing that makes an
 * `ai_commentary` block act, but either half alone is enough to say a run calls a model.
 *
 * @param {{blocks: object[]}} recipe
 * @param {number|boolean|undefined|null} aiCommentaryFlag the report's ai_commentary column
 * @returns {boolean}
 * @throws {Error} `code: "bad_recipe"` for anything that is not a recipe
 */
export function recipeCallsModel(recipe, aiCommentaryFlag) {
  const blocks = assertRecipe(recipe);
  if (aiCommentaryFlag === 1 || aiCommentaryFlag === true) return true;
  return blocks.some((block) => MODEL_BLOCK_TYPES.includes(block.type));
}