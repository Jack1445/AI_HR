import { inflateSync } from 'node:zlib';

/** Decode only Chromium's non-interlaced 8-bit RGB/RGBA screenshot format. */
export function inspectResumePng(bytes: Uint8Array): { width: number; height: number; darkPixels: number; darkRows: number; readable: boolean } {
  const png = Buffer.from(bytes);
  if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('截图不是 PNG');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const channels = png[25] === 2 ? 3 : png[25] === 6 ? 4 : 0;
  if (png.toString('ascii', 12, 16) !== 'IHDR' || !width || !height || width * height > 40_000_000 || png[24] !== 8 || !channels || png[26] !== 0 || png[27] !== 0 || png[28] !== 0) throw new Error('截图 PNG 格式或尺寸不受支持');
  const chunks: Buffer[] = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const size = png.readUInt32BE(offset);
    if (offset + size + 12 > png.length) throw new Error('截图 PNG 数据不完整');
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height });
  if (raw.length !== (stride + 1) * height) throw new Error('截图 PNG 像素数据不完整');
  let previous = Buffer.alloc(stride), current = Buffer.alloc(stride), darkPixels = 0, darkRows = 0;
  for (let y = 0; y < height; y++) {
    const offset = y * (stride + 1), filter = raw[offset];
    if (filter > 4) throw new Error('截图 PNG 像素过滤器无效');
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? current[x - channels] : 0, up = previous[x], corner = x >= channels ? previous[x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = up;
      if (filter === 3) predictor = Math.floor((left + up) / 2);
      if (filter === 4) {
        const p = left + up - corner, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
        predictor = a <= b && a <= c ? left : b <= c ? up : corner;
      }
      current[x] = (raw[offset + 1 + x] + predictor) & 255;
    }
    let rowInk = 0;
    for (let x = 0; x < stride; x += channels) {
      const alpha = channels === 4 ? current[x + 3] / 255 : 1;
      // Pale BOSS watermarks are not evidence of a rendered resume.
      const light = (0.2126 * current[x] + 0.7152 * current[x + 1] + 0.0722 * current[x + 2]) * alpha + 255 * (1 - alpha);
      if (light < 180) rowInk++;
    }
    darkPixels += rowInk;
    if (rowInk >= 5) darkRows++;
    [previous, current] = [current, previous];
  }
  return { width, height, darkPixels, darkRows, readable: darkPixels >= Math.max(200, width * height * 0.0005) && darkRows >= 8 };
}
