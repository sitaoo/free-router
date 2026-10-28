#!/usr/bin/env node
// Icons the page declares. The tab icon is an SVG, but Safari's pinned tab and
// iOS's home-screen icon each have their own format rules, and getting them
// wrong fails silently — a solid block in the pinned tab, no icon at all on the
// home screen. These tests pin the rules down.
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { APPLE_TOUCH_ICON_SIZE, FAVICON_SVG, MASK_ICON_SVG, appleTouchIconPng } from '../app/icons.mjs';

// 1. Tab icon: a real SVG with a viewBox, and no script (it is served under
// `default-src 'none'` with only img-src allowed).
assert.match(FAVICON_SVG, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
assert.match(FAVICON_SVG, /viewBox="0 0 32 32"/);
assert.equal(FAVICON_SVG.includes('<script'), false);

// 2. Safari pinned tab: Safari paints only the alpha channel with the `color`
// attribute, so the artwork must be one black shape on transparency in the one
// viewBox Safari documents. Anything else renders as a solid tile.
assert.match(MASK_ICON_SVG, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
assert.match(MASK_ICON_SVG, /viewBox="0 0 16 16"/, 'Safari requires a 16x16 viewBox');
assert.equal(MASK_ICON_SVG.includes('<rect'), false, 'no background tile: it would fill the whole icon');
assert.equal(MASK_ICON_SVG.includes('linearGradient'), false, 'gradients are meaningless in a mask');
assert.match(MASK_ICON_SVG, /stroke="#000000"|stroke="#000"/, 'the shape must be black; the color attribute supplies the hue');
assert.doesNotMatch(MASK_ICON_SVG, /#fff|white/i, 'white would be invisible when masked');
// A single path layer, as Safari documents.
assert.equal((MASK_ICON_SVG.match(/<path/g) || []).length, 1);
assert.equal(MASK_ICON_SVG.includes('<script'), false);

// 3. iOS home screen: PNG, per Apple's documentation — SVG is not supported.
const png = appleTouchIconPng();
assert.deepEqual(
  [...png.subarray(0, 8)],
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'must be a PNG',
);
assert.equal(png.readUInt32BE(8), 13, 'IHDR length');
assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR');
assert.equal(png.readUInt32BE(16), APPLE_TOUCH_ICON_SIZE, 'width');
assert.equal(png.readUInt32BE(20), APPLE_TOUCH_ICON_SIZE, 'height');
assert.equal(png[24], 8, 'bit depth');
assert.equal(png[25], 2, 'truecolour, so there is no alpha channel to turn black on iOS');

// The IDAT stream must decompress to exactly the scanlines we wrote, or the
// browser shows a broken image.
const idatLength = png.readUInt32BE(33);
assert.equal(png.subarray(37, 41).toString('latin1'), 'IDAT');
const raw = zlib.inflateSync(png.subarray(41, 41 + idatLength));
assert.equal(raw.length, APPLE_TOUCH_ICON_SIZE * (1 + APPLE_TOUCH_ICON_SIZE * 3));
for (let y = 0; y < APPLE_TOUCH_ICON_SIZE; y += 1) {
  assert.equal(raw[y * (1 + APPLE_TOUCH_ICON_SIZE * 3)], 0, 'filter byte must be None');
}

// Full-bleed: the corners are the accent tile, never transparent. A transparent
// corner is composited as black once iOS rounds the icon.
const pixel = (x, y) => {
  const offset = y * (1 + APPLE_TOUCH_ICON_SIZE * 3) + 1 + x * 3;
  return [raw[offset], raw[offset + 1], raw[offset + 2]];
};
assert.deepEqual(pixel(0, 0), [0x3b, 0x93, 0xff], 'top-left corner is the light end of the gradient');
assert.deepEqual(pixel(APPLE_TOUCH_ICON_SIZE - 1, APPLE_TOUCH_ICON_SIZE - 1), [0x0b, 0x62, 0xd6], 'bottom-right is the deep end');

// The mark itself is drawn: a pixel on the heartbeat line is white, and the
// icon is not a flat colour.
const centre = pixel(Math.round(APPLE_TOUCH_ICON_SIZE * 0.5), Math.round(APPLE_TOUCH_ICON_SIZE * 0.5));
assert.notDeepEqual(centre, [0x3b, 0x93, 0xff], 'the heartbeat line must be drawn');
// The first, flat segment of the pulse runs from x=4.5 to 9.1 at y=17 in the
// 32-unit design space; sample its middle in PNG pixels.
const scale = APPLE_TOUCH_ICON_SIZE / 32;
const onLine = pixel(Math.round(6.8 * scale), Math.round(17 * scale));
assert.ok(onLine[0] > 200 && onLine[1] > 200 && onLine[2] > 200, `the stroke should be near-white, got ${onLine}`);

// Cached: a second call must not rebuild the megabytes of scanlines.
assert.equal(appleTouchIconPng(), png, 'the PNG is built once');

console.log('icon unit tests passed');
