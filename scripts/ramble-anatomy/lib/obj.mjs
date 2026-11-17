/**
 * Minimal Wavefront OBJ reader for the posed meshes the anatomy pipeline
 * writes: one file per vocabulary id, up to three `o`/`g` objects named
 * right / left / mid, faces are triangles (or polygons to fan-triangulate).
 *
 * Every object is returned independent: its `positions` carry only the
 * vertices its own faces reference, re-indexed from zero, and its `indices`
 * address that local array. A consumer can therefore draw objects separately
 * without knowing a sibling object ever existed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WHITESPACE = /\s+/;

/** A face reference ("a", "a/b", "a//c", "a/b/c") as a zero-based vertex index. */
function vertexIndex(token, vertexCount, lineNumber) {
  const head = token.split("/")[0];
  if (!/^[+-]?\d+$/.test(head)) {
    throw new Error("parseObj: face reference \"" + token + "\" on line " + lineNumber + " is not a vertex index");
  }
  const raw = Number(head);
  /* A negative index counts back from the vertices read so far. */
  const index = raw < 0 ? vertexCount + raw : raw - 1;
  if (index < 0 || index >= vertexCount) {
    throw new Error("parseObj: face reference " + raw + " on line " + lineNumber +
      " points outside the " + vertexCount + " vertices read so far");
  }
  return index;
}

/**
 * Parse OBJ text into { objects: [{ name, positions: Float64Array, indices: Uint32Array }] }.
 * `v` lines are global; `o`/`g` lines start a new object; only `f` lines bind
 * vertices to an object. Empty objects are dropped.
 */
export function parseObj(text) {
  if (typeof text !== "string") throw new Error("parseObj: OBJ text must be a string");
  const positions = [];               // global x, y, z, x, y, z, ...
  const groups = [];                  // { name, faces: [[g, g, g], ...] } in global indices
  let current = null;
  const openObject = (name) => {
    current = { name: name || "default", faces: [] };
    groups.push(current);
  };

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line[0] === "#") continue;
    const tokens = line.split(WHITESPACE).filter((t) => t !== "");
    const tag = tokens[0];
    if (tag === "o" || tag === "g") {
      openObject(tokens.slice(1).join(" ").trim());
      continue;
    }
    if (tag === "v") {
      const x = Number(tokens[1]);
      const y = Number(tokens[2]);
      const z = Number(tokens[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error("parseObj: unreadable vertex on line " + (i + 1) + ": " + line);
      }
      positions.push(x, y, z);
      continue;
    }
    if (tag === "f") {
      if (!current) openObject(null);
      const vertexCount = positions.length / 3;
      const polygon = [];
      for (let k = 1; k < tokens.length; k++) {
        polygon.push(vertexIndex(tokens[k], vertexCount, i + 1));
      }
      /* Fan triangulation: a polygon of n corners becomes n - 2 triangles. */
      for (let k = 1; k + 1 < polygon.length; k++) {
        current.faces.push([polygon[0], polygon[k], polygon[k + 1]]);
      }
      continue;
    }
    /* Any other line ("vn", "vt", "s", "usemtl", ...) is not this reader's business. */
  }

  const objects = [];
  for (const group of groups) {
    if (group.faces.length === 0) continue;
    const localOf = new Map();        // global index -> local index
    const order = [];                 // local index -> global index
    const indices = new Uint32Array(group.faces.length * 3);
    let at = 0;
    for (const face of group.faces) {
      for (const global of face) {
        let local = localOf.get(global);
        if (local === undefined) {
          local = order.length;
          localOf.set(global, local);
          order.push(global);
        }
        indices[at] = local;
        at += 1;
      }
    }
    const local = new Float64Array(order.length * 3);
    for (let i = 0; i < order.length; i++) {
      const g = order[i] * 3;
      local[i * 3] = positions[g];
      local[i * 3 + 1] = positions[g + 1];
      local[i * 3 + 2] = positions[g + 2];
    }
    objects.push({ name: group.name, positions: local, indices });
  }
  return { objects };
}

/** Every `*.obj` in a directory as { [id]: parsed }, the id being the file name. */
export function loadPosedDir(dir) {
  const meshes = {};
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".obj")) continue;
    meshes[name.slice(0, -4)] = parseObj(readFileSync(join(dir, name), "utf8"));
  }
  return meshes;
}