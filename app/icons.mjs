// The three icons the page declares, each built to that format's own rules
// rather than reusing one SVG for all of them:
//
//   icon        — the tab. Colour is ours; an SVG at 32px stays crisp.
//   mask-icon   — Safari pinned tab. Safari uses only the alpha channel and
//                 paints it with the `color` attribute, so it must be a single
//                 black shape on transparency, in a 16x16 viewBox. Handing it
//                 the coloured tile renders as a solid block.
//   apple-touch    — iOS home screen. Apple documents PNG only, and iOS supplies
//                 its own rounded mask, so this one is full-bleed with no
//                 transparency (transparent corners show as black).
//
// The PNG is generated here with node:zlib rather than checked in, so the repo
// stays binary-free and the icon can never drift from the SVG it mirrors.
import zlib from 'node:zlib';

// The brand mark: an accent tile with the heartbeat line from the top bar and
// login card, so the tab matches the page instead of inventing a second symbol.
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Free Router">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#3b93ff"/><stop offset="1" stop-color="#0b62d6"/>
</linearGradient></defs>
<rect width="32" height="32" rx="8" fill="url(#g)"/>
<path d="M4.5 17h4.6l3.2-8.6 4.6 15.6 3.2-7.4h6.4" fill="none" stroke="#ffffff" stroke-width="3.1" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

// Safari pinned tabs: one black shape, transparent everywhere else, and the
// viewBox Safari documents. The stroke is heavier than the tab icon's because
// the pinned tab is drawn a single colour at 16px.
export const MASK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
<path d="M2 8.5h2.3l1.6-4.3 2.3 8.3 1.6-4.5h4.2" fill="none" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

const TILE = '#0b62d6';
const TILE_LIGHT = '#3b93ff';

// Points of the heartbeat line in the 32-unit space the favicon uses.
const PULSE = [
  [4.5, 17], [9.1, 17], [12.3, 8.4], [16.9, 24], [20.1, 16.6], [26.5, 16.6],
];

function distanceToSegment(px, py, [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function distanceToPulse(px, py) {
  let best = Infinity;
  for (let index = 0; index < PULSE.length - 1; index += 1) {
    best = Math.min(best, distanceToSegment(px, py, PULSE[index], PULSE[index + 1]));
  }
  return best;
}

// Coverage of the pulse stroke at one sample point, in the 32-unit space.
function pulseCoverage(px, py) {
  const halfWidth = 3.1 / 2;
  // Rounded caps are the distance to the end points, which the segment
  // distance already gives for t clamped to [0,1].
  return distanceToPulse(px, py) <= halfWidth ? 1 : 0;
}

function mix(from, to, t) {
  const a = [
    parseInt(from.slice(1, 3), 16),
    parseInt(from.slice(3, 5), 16),
    parseInt(from.slice(5, 7), 16),
  ];
  const b = [
    parseInt(to.slice(1, 3), 16),
    parseInt(to.slice(3, 5), 16),
    parseInt(to.slice(5, 7), 16),
  ];
  return a.map((value, index) => Math.round(value + (b[index] - value) * t));
}

// Rasterises the tile at `size`, sampling 3x3 per pixel so the diagonal stroke
// and the gradient come out smooth rather than stair-stepped.
function rasterize(size) {
  const rows = [];
  const samples = 3;
  for (let y = 0; y < size; y += 1) {
    // filter byte 0 (None) then RGB triples
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          // Sample position in the 32-unit design space.
          const ux = ((x + (sx + 0.5) / samples) / size) * 32;
          const uy = ((y + (sy + 0.5) / samples) / size) * 32;
          const [tr, tg, tb] = mix(TILE_LIGHT, TILE, (ux + uy) / 64);
          const onPulse = pulseCoverage(ux, uy);
          r += onPulse ? 255 : tr;
          g += onPulse ? 255 : tg;
          b += onPulse ? 255 : tb;
        }
      }
      const total = samples * samples;
      const offset = 1 + x * 3;
      row[offset] = Math.round(r / total);
      row[offset + 1] = Math.round(g / total);
      row[offset + 2] = Math.round(b / total);
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour RGB
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const APPLE_TOUCH_ICON_SIZE = 180;

let appleTouchCache = null;

// Full-bleed on purpose: iOS applies its own rounded mask, and a transparent
// corner would be composited as black.
export function appleTouchIconPng() {
  if (!appleTouchCache) {
    appleTouchCache = encodePng(
      APPLE_TOUCH_ICON_SIZE,
      APPLE_TOUCH_ICON_SIZE,
      rasterize(APPLE_TOUCH_ICON_SIZE),
    );
  }
  return appleTouchCache;
}
