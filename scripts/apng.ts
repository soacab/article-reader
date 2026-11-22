import { crc32 } from "node:zlib";
import { resourceRejection } from "./types";

const signature = Buffer.from("89504e470d0a1a0a", "hex");
type Chunk = { type: string; data: Buffer };
function chunk(type: string, data: Buffer) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); out.write(type, 4, 4, "ascii"); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}
const invalid = () => resourceRejection("APNG/PNG 结构无法可靠校验");

// Sharp's PNG loader sees only the default image. Validate APNG controls ourselves
// and reconstruct each frame as a PNG for the same bounded native decoder.
export function apngFrames(bytes: Buffer, limits: { frames: number; pixels: number }): { images: Buffer[]; frameCount: number } | null {
  if (!bytes.subarray(0, 8).equals(signature)) return null;
  const chunks: Chunk[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw invalid();
    const size = bytes.readUInt32BE(offset), end = offset + size + 12;
    if (end > bytes.length) throw invalid();
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, end - 4);
    chunks.push({ type, data }); offset = end;
  }
  const controls = chunks.filter(c => c.type === "acTL");
  if (!controls.length && !chunks.some(c => c.type === "fcTL" || c.type === "fdAT")) return null;
  // CRCs include controls as well as compressed pixels; no fallback to static PNG.
  offset = 8;
  for (const c of chunks) {
    if (!/^[A-Za-z]{4}$/.test(c.type)) throw invalid();
    if (crc32(bytes.subarray(offset + 4, offset + 8 + c.data.length)) !== bytes.readUInt32BE(offset + 8 + c.data.length)) throw invalid();
    offset += c.data.length + 12;
  }
  const header = chunks[0];
  if (header?.type !== "IHDR" || header.data.length !== 13 || controls.length !== 1 || controls[0].data.length !== 8 || chunks.at(-1)?.type !== "IEND" || chunks.at(-1)!.data.length) throw invalid();
  const width = header.data.readUInt32BE(0), height = header.data.readUInt32BE(4);
  const frames = controls[0].data.readUInt32BE(0);
  if (!width || !height || !frames) throw invalid();
  if (frames > limits.frames) throw resourceRejection(`动画帧数 ${frames} 超过上限 ${limits.frames}`);
  // Count full composited canvases, not just small update rectangles.
  if (width * height * frames > limits.pixels) throw resourceRejection(`图片累计像素 ${width * height * frames} 超过上限 ${limits.pixels}`);
  let sequence = 0, seenControl = false, seenIdat = false, idatEnded = false;
  const shared: Buffer[] = [], result: Buffer[] = [];
  let frame: { header: Buffer; data: Buffer[]; usesIdat: boolean } | undefined;
  function flush() {
    if (!frame) return;
    if (!frame.data.length) throw invalid();
    result.push(Buffer.concat([signature, chunk("IHDR", frame.header), ...shared, ...frame.data.map(data => chunk("IDAT", data)), chunk("IEND", Buffer.alloc(0))]));
    frame = undefined;
  }
  for (const c of chunks.slice(1)) {
    if (seenIdat && c.type !== "IDAT") idatEnded = true;
    if (c.type === "acTL") {
      if (seenIdat || seenControl) throw invalid();
      seenControl = true;
    } else if (c.type === "fcTL") {
      if (!seenControl || c.data.length !== 26 || c.data.readUInt32BE(0) !== sequence++) throw invalid();
      flush();
      if (result.length >= frames) throw invalid();
      const w = c.data.readUInt32BE(4), h = c.data.readUInt32BE(8), x = c.data.readUInt32BE(12), y = c.data.readUInt32BE(16);
      if (!w || !h || x + w > width || y + h > height || c.data[24] > 2 || c.data[25] > 1) throw invalid();
      if (!seenIdat && (w !== width || h !== height || x || y)) throw invalid();
      const ihdr = Buffer.from(header.data); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
      frame = { header: ihdr, data: [], usesIdat: !seenIdat };
    } else if (c.type === "IDAT") {
      if (!seenControl || idatEnded || frame && !frame.usesIdat) throw invalid();
      seenIdat = true;
      if (frame) frame.data.push(c.data);
    } else if (c.type === "fdAT") {
      if (!seenIdat || !frame || frame.usesIdat || c.data.length < 4 || c.data.readUInt32BE(0) !== sequence++) throw invalid();
      frame.data.push(c.data.subarray(4));
    } else if (c.type === "PLTE" || c.type === "tRNS") {
      if (seenIdat) throw invalid();
      shared.push(chunk(c.type, c.data));
    } else if (c.type === "IEND") {
      if (c !== chunks.at(-1) || !seenIdat) throw invalid();
      flush();
    } else if (!/^[a-z]/.test(c.type)) throw invalid();
  }
  if (result.length !== frames) throw invalid();
  // APNG may have a separate default/poster image outside the animation.
  // Decode that too, and include its canvas in the cumulative pixel budget.
  if (chunks.findIndex(c => c.type === "IDAT") < chunks.findIndex(c => c.type === "fcTL")) {
    if (width * height * (frames + 1) > limits.pixels) throw resourceRejection(`图片累计像素 ${width * height * (frames + 1)} 超过上限 ${limits.pixels}`);
    result.unshift(bytes);
  }
  return { images: result, frameCount: frames };
}
