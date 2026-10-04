/** Pixel size from a PNG/JPEG/GIF header (no decoding). Anything else → WsError("bad_image"). */
import { WsError } from "../result.js";

const bad = () => new WsError("bad_image", "the image must be a PNG, JPEG or GIF file");
// Larger sides would overflow the EMU extents (ST_PositiveCoordinate) and make an invalid document
export const MAX_SIDE_PX = 65535;
function sized(type, width, height) {
  if (!(width > 0 && height > 0)) throw bad();
  if (width > MAX_SIDE_PX || height > MAX_SIDE_PX) throw new WsError("bad_image", `the image is ${width}×${height} px; each side must be at most ${MAX_SIDE_PX} px`);
  return { type, width, height };
}

export function imageSize(b) {
  const u = Buffer.from(b);
  if (u.length >= 24 && u.readUInt32BE(0) === 0x89504e47 && u.toString("ascii", 12, 16) === "IHDR") return sized("png", u.readUInt32BE(16), u.readUInt32BE(20));
  if (u.length >= 10 && u.toString("ascii", 0, 4) === "GIF8") return sized("gif", u.readUInt16LE(6), u.readUInt16LE(8));
  if (u.length > 4 && u[0] === 0xff && u[1] === 0xd8) {
    let i = 2;
    while (i + 9 < u.length) {
      if (u[i] === 0xff && (u[i + 1] === 0xd9 || u[i + 1] === 0xda)) break; // EOI / start of scan: no SOF before it
      if (u[i] !== 0xff) { i++; continue; }
      const m = u[i + 1];
      // SOFn frames carry the size; DHT (C4), JPG (C8) and DAC (CC) share the range but do not
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return sized("jpeg", u.readUInt16BE(i + 7), u.readUInt16BE(i + 5));
      i += 2 + u.readUInt16BE(i + 2);
    }
  }
  throw bad();
}
