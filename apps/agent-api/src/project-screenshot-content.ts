import { unzlibSync } from "fflate";

/** Verify the container and image payload before accepting WebP from the runner. */
export function isWebpScreenshot(data: Buffer): boolean {
  if (data.length < 30 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP" || data.readUInt32LE(4) !== data.length - 8) return false;
  for (let offset = 12; offset + 8 <= data.length;) {
    const size = data.readUInt32LE(offset + 4);
    if (size > data.length - offset - 8) return false;
    const type = data.toString("ascii", offset, offset + 4), start = offset + 8;
    if (type === "VP8 " && size >= 10 && (data[start]! & 1) === 0 && data.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42]))) {
      const width = data.readUInt16LE(start + 6) & 16383, height = data.readUInt16LE(start + 8) & 16383;
      return width > 0 && height > 0 && width <= 1920 && height <= 1200;
    }
    if (type === "VP8L" && size >= 5 && data[start] === 47) {
      const bits = data.readUInt32LE(start + 1), width = (bits & 16383) + 1, height = ((bits >>> 14) & 16383) + 1;
      return (bits >>> 29) === 0 && width <= 1920 && height <= 1200;
    }
    offset += 8 + size + (size % 2);
  }
  return false;
}

/** Reject a solid-color browser capture instead of saving an empty app as a thumbnail.
 * Chromium screenshots use non-interlaced 8-bit RGB/RGBA PNGs. Other encodings are left unchanged. */
export function screenshotHasDetail(png: Uint8Array): boolean {
  const data = Buffer.from(png);
  if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return true;
  try {
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20), color = data[25];
    if (!width || !height || width > 1920 || height > 1200 || data[24] !== 8 || ![2,6].includes(color!) || data[28] !== 0) return true;
    const channels = color === 6 ? 4 : 3, stride = width * channels;
    const chunks: Buffer[] = [];
    for (let offset = 8; offset + 12 <= data.length;) {
      const length = data.readUInt32BE(offset);
      if (length > data.length - offset - 12) return true;
      if (data.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(data.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    const raw = unzlibSync(Buffer.concat(chunks), { out: new Uint8Array((stride + 1) * height) });
    let previous = new Uint8Array(stride), first: Uint8Array | undefined;
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      if (filter === undefined || filter > 4) return true;
      const row = new Uint8Array(stride);
      for (let x = 0; x < stride; x++) {
        const left = x >= channels ? row[x - channels]! : 0, up = previous[x]!, upperLeft = x >= channels ? previous[x - channels]! : 0;
        const p = left + up - upperLeft, a = Math.abs(p-left), b = Math.abs(p-up), c = Math.abs(p-upperLeft);
        const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left+up)/2) : filter === 4 ? a <= b && a <= c ? left : b <= c ? up : upperLeft : 0;
        row[x] = (raw[y * (stride + 1) + 1 + x]! + predictor) & 255;
        if (first && row[x] !== first[x % channels]) return true;
        if (!first && x === channels - 1) first = row.slice(0, channels);
      }
      previous = row;
    }
    return false;
  } catch { return true; }
}
