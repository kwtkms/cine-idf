// Genere assets/cine-idf.ico (bobine de film) sans aucune dependance.
// Rendu en 4x puis moyenne des pixels : ca suffit pour un anticrenelage propre.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SS = 4; // facteur de suréchantillonnage

const BG = [255, 183, 3];      // jaune accent
const DARK = [22, 27, 35];     // bleu-nuit

function draw(size) {
  const S = size * SS;
  const px = Buffer.alloc(S * S * 4);

  const put = (x, y, [r, g, b], a = 255) => {
    const i = (y * S + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };

  const R = S * 0.22;                       // rayon des coins
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, R), S - R);
    const cy = Math.min(Math.max(y, R), S - R);
    return (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
  };

  const c = S / 2;
  const reel = S * 0.36;        // rayon de la bobine
  const hub = S * 0.075;        // trou central
  const hole = S * 0.082;       // perforations
  const holeAt = S * 0.215;     // distance des perforations au centre

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!inRounded(x + 0.5, y + 0.5)) continue; // hors de l'icone : transparent
      let color = BG;

      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      if (d <= reel) {
        color = DARK;
        if (d <= hub) color = BG;
        for (let k = 0; k < 5 && color === DARK; k++) {
          const a = (k / 5) * Math.PI * 2 - Math.PI / 2;
          const hx = c + Math.cos(a) * holeAt;
          const hy = c + Math.sin(a) * holeAt;
          if (Math.hypot(x + 0.5 - hx, y + 0.5 - hy) <= hole) color = BG;
        }
      }
      put(x, y, color);
    }
  }

  // Réduction par moyenne des blocs SS x SS.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * S + (x * SS + dx)) * 4;
          const al = px[i + 3];
          r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += al;
        }
      }
      const j = (y * size + x) * 4;
      out[j] = a ? Math.round(r / a) : 0;
      out[j + 1] = a ? Math.round(g / a) : 0;
      out[j + 2] = a ? Math.round(b / a) : 0;
      out[j + 3] = Math.round(a / (SS * SS));
    }
  }
  return out;
}

/* ------------------------------------------------------------------- PNG */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function toPNG(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filtre "none"
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // 8 bits par canal
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------- ICO */

function toICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);              // type icone
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);                 // plans
    e.writeUInt16LE(32, 6);                // bits par pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const sizes = [16, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, png: toPNG(draw(size), size) }));

fs.mkdirSync(path.join(ROOT, 'assets'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'assets', 'cine-idf.ico'), toICO(images));
fs.writeFileSync(path.join(ROOT, 'public', 'icon.png'), images.at(-1).png);
console.log('assets/cine-idf.ico + public/icon.png generes');
