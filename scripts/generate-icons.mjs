// Génère les icônes PWA (PNG) sans dépendance : un carré bleu arrondi avec un « N »
// blanc, dessiné par rastérisation avec suréchantillonnage (anti-crénelage).
// Usage : node scripts/generate-icons.mjs  → écrit dans public/icons/
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [0x26, 0x44, 0x6b];
const FG = [0xff, 0xff, 0xff];

// Le « N » (coordonnées sur une grille de 512) : deux montants et une diagonale.
const POLYGONS = [
  [[150, 140], [194, 140], [194, 372], [150, 372]],
  [[318, 140], [362, 140], [362, 372], [318, 372]],
  [[150, 140], [200, 140], [362, 372], [312, 372]],
];

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundedSquare(x, y, radius) {
  const size = 512;
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/** Couleur RGBA d'un point de la grille 512 ; `maskable` : fond plein sans coins arrondis. */
function sample(x, y, maskable) {
  if (!maskable && !inRoundedSquare(x, y, 96)) return [0, 0, 0, 0];
  return POLYGONS.some((p) => inPolygon(x, y, p)) ? [...FG, 255] : [...BG, 255];
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, maskable) {
  const SS = 3; // suréchantillonnage 3×3
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py += 1) {
    raw[py * (size * 4 + 1)] = 0; // filtre « aucun »
    for (let px = 0; px < size; px += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const [cr, cg, cb, ca] = sample(((px + (sx + 0.5) / SS) * 512) / size, ((py + (sy + 0.5) / SS) * 512) / size, maskable);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const offset = py * (size * 4 + 1) + 1 + px * 4;
      const n = SS * SS;
      raw[offset] = a ? Math.round(r / a) : 0;
      raw[offset + 1] = a ? Math.round(g / a) : 0;
      raw[offset + 2] = a ? Math.round(b / a) : 0;
      raw[offset + 3] = Math.round(a / n);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // profondeur
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = new URL("../public/icons/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const files = [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-maskable-512.png", 512, true],
  ["apple-touch-icon.png", 180, true],
];
for (const [name, size, maskable] of files) {
  writeFileSync(new URL(name, outDir), png(size, maskable));
  console.log(`public/icons/${name} (${size}×${size}${maskable ? ", maskable" : ""})`);
}
