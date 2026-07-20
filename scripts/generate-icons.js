// Generate PWA icons (pastel sage rounded square + a white star) as raw
// PNGs using only Node's built-in zlib. Run: node scripts/generate-icons.js
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const BG = [163, 184, 153]; // sage #A3B899
const FG = [255, 253, 249]; // near-white #FFFDF9
const ACCENT = [229, 192, 120]; // soft ochre #E5C078

function makeCanvas(size, bg) {
  const canvas = [];
  for (let y = 0; y < size; y++) {
    canvas.push(new Array(size).fill(bg));
  }
  return canvas;
}

function fillRoundedRect(canvas, x0, y0, x1, y1, radius, color) {
  const size = canvas.length;
  for (let y = Math.max(0, y0); y < Math.min(size, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(size, x1); x++) {
      let cx = 0, cy = 0, inCorner = false;
      if (x < x0 + radius && y < y0 + radius) { cx = x0 + radius; cy = y0 + radius; inCorner = true; }
      else if (x >= x1 - radius && y < y0 + radius) { cx = x1 - radius; cy = y0 + radius; inCorner = true; }
      else if (x < x0 + radius && y >= y1 - radius) { cx = x0 + radius; cy = y1 - radius; inCorner = true; }
      else if (x >= x1 - radius && y >= y1 - radius) { cx = x1 - radius; cy = y1 - radius; inCorner = true; }
      if (inCorner && ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius)) continue;
      canvas[y][x] = color;
    }
  }
}

function fillCircle(canvas, cx, cy, r, color) {
  const size = canvas.length;
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(size, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(size, Math.ceil(cx + r)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) canvas[y][x] = color;
    }
  }
}

// Even-odd scanline fill for an arbitrary simple polygon (array of [x,y]).
function fillPolygon(canvas, points, color) {
  const size = canvas.length;
  const ys = points.map((p) => p[1]);
  const yMin = Math.max(0, Math.floor(Math.min(...ys)));
  const yMax = Math.min(size - 1, Math.ceil(Math.max(...ys)));
  for (let y = yMin; y <= yMax; y++) {
    const scanY = y + 0.5;
    const xs = [];
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      if ((y1 <= scanY && y2 > scanY) || (y2 <= scanY && y1 > scanY)) {
        const t = (scanY - y1) / (y2 - y1);
        xs.push(x1 + t * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i < xs.length; i += 2) {
      if (xs[i + 1] === undefined) break;
      const xStart = Math.max(0, Math.round(xs[i]));
      const xEnd = Math.min(size - 1, Math.round(xs[i + 1]));
      for (let x = xStart; x <= xEnd; x++) canvas[y][x] = color;
    }
  }
}

function starPoints(cx, cy, outerR, innerR, points, rotation) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = rotation + (i * Math.PI) / points;
    pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  return pts;
}

function drawIcon(canvas, size) {
  const bgR = Math.round(size * 0.22);
  fillRoundedRect(canvas, 0, 0, size, size, bgR, BG);

  const cx = size / 2;
  const cy = size / 2;
  const outerR = size * 0.32;
  const innerR = outerR * 0.42;
  const star = starPoints(cx, cy, outerR, innerR, 5, -Math.PI / 2);
  fillPolygon(canvas, star, FG);

  // small accent dot as a playful highlight, upper-right of the star
  fillCircle(canvas, cx + outerR * 0.78, cy - outerR * 0.9, size * 0.045, ACCENT);
}

function crc32(buf) {
  return zlib.crc32 ? zlib.crc32(buf) >>> 0 : (() => {
    let c, crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = (crc ^ buf[i]) & 0xff;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
  })();
}

function chunk(tag, data) {
  const tagBuf = Buffer.from(tag, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([tagBuf, data])), 0);
  return Buffer.concat([lenBuf, tagBuf, data, crcBuf]);
}

function writePng(filePath, canvas) {
  const size = canvas.length;
  const rowBytes = 1 + size * 4;
  const raw = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = canvas[y][x];
      const off = rowStart + 1 + x * 4;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = 255;
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
  fs.writeFileSync(filePath, png);
}

function main() {
  const outDir = path.join(__dirname, "..", "icons");
  fs.mkdirSync(outDir, { recursive: true });
  for (const [size, name] of [[192, "icon-192.png"], [512, "icon-512.png"], [180, "apple-touch-icon.png"]]) {
    const canvas = makeCanvas(size, BG);
    drawIcon(canvas, size);
    writePng(path.join(outDir, name), canvas);
    console.log("wrote", name);
  }
}

main();
