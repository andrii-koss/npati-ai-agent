import { unzlibSync } from "fflate";

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
