/** Order-preserving OOXML package. Untouched entries are written back byte-identical (uncompressed content). */
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { WsError } from "../result.js";
import { parseXml, serializeXml } from "./xml.js";

export const ZIP_LIMITS = Object.freeze({ maxEntries: 5000, maxTotal: 200 * 1024 * 1024, maxRatio: 200, maxXml: 30 * 1024 * 1024 });

export class OoxmlPackage {
  constructor(files, order, levels, limits) { this.files = Object.assign(Object.create(null), files); /* prototype-safe: "constructor" is just a part name */ this.order = order; this.levels = levels; this.limits = limits; this.docs = new Map(); this.dirty = new Set(); this.removed = new Set(); }
  static open(bytes, limits = ZIP_LIMITS) {
    let count = 0, total = 0; const order = []; const levels = new Map();
    let files;
    try {
      files = unzipSync(new Uint8Array(bytes), {
        filter: (f) => {
          if (++count > limits.maxEntries) throw new WsError("malformed_document", `too many parts (> ${limits.maxEntries})`);
          total += f.originalSize;
          if (total > limits.maxTotal) throw new WsError("malformed_document", "the file unpacks to more than 200 MB");
          if (f.originalSize > 1024 * 1024 && f.size > 0 && f.originalSize / f.size > limits.maxRatio) throw new WsError("malformed_document", `"${f.name}" is compressed suspiciously well (possible zip bomb)`);
          // XML parts are capped from the declared size, before anything is inflated (spec §7.2)
          if (/\.(xml|rels)$/i.test(f.name) && f.originalSize > limits.maxXml) throw new WsError("too_large", `part ${f.name} is larger than 30 MB`);
          // fflate collects entries in a plain object: an entry named "__proto__" would replace its prototype
          if (f.name === "__proto__") throw new WsError("malformed_document", 'the file has a part named "__proto__", which is not allowed');
          order.push(f.name); levels.set(f.name, f.compression); return true;
        },
      });
    } catch (e) { if (e instanceof WsError) throw e; throw new WsError("malformed_document", "not a valid office file (zip)"); }
    if (!Object.hasOwn(files, "[Content_Types].xml")) throw new WsError("malformed_document", "not an office file ([Content_Types].xml missing)");
    return new OoxmlPackage(files, order, levels, limits);
  }
  has(n) { return !this.removed.has(n) && (Object.hasOwn(this.files, n) || this.docs.has(n)); }
  names() { return [...this.order, ...[...this.docs.keys()].filter((n) => !this.order.includes(n))].filter((n) => this.has(n)); }
  bytes(n) { if (this.dirty.has(n)) return strToU8(serializeXml(this.docs.get(n))); return Object.hasOwn(this.files, n) ? this.files[n] : undefined; }
  text(n) { const b = Object.hasOwn(this.files, n) ? this.files[n] : undefined; if (!b) throw new WsError("malformed_document", `missing part ${n}`); if (b.length > this.limits.maxXml) throw new WsError("too_large", `part ${n} is larger than 30 MB`); return strFromU8(b); }
  xml(n) { if (!this.docs.has(n)) this.docs.set(n, parseXml(this.text(n), n)); return this.docs.get(n); }
  markDirty(n) { this.dirty.add(n); this.removed.delete(n); }
  setXml(n, doc) { this.docs.set(n, doc); this.markDirty(n); }
  setBytes(n, u8) { this.files[n] = u8; this.docs.delete(n); this.dirty.delete(n); this.removed.delete(n); if (!this.order.includes(n)) this.order.push(n); }
  remove(n) { this.removed.add(n); this.dirty.delete(n); }
  changed() { return new Set([...this.dirty, ...this.removed]); }
  save() {
    const out = {};
    // [Content_Types].xml goes first (OPC convention; some writers, e.g. openpyxl, put it last); every other part keeps its order.
    const names = this.names();
    for (const n of ["[Content_Types].xml", ...names.filter((x) => x !== "[Content_Types].xml")]) out[n] = [this.bytes(n), { level: this.levels.get(n) === 0 ? 0 : 6 }];
    return zipSync(out);
  }
}
