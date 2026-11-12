import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareImages } from '../lib/compare.mjs';
import { decodePng, encodePng } from '../lib/png.mjs';

const W = 100;
const H = 100;
const solid = (r, g, b) => {
  const data = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([r, g, b, 255], i * 4);
  return data;
};
/** Returns a copy of `data` with the first `n` pixels shifted by `by` in the red channel. */
const shifted = (data, n, by) => {
  const copy = Buffer.from(data);
  for (let i = 0; i < n; i++) copy[i * 4] = Math.min(255, copy[i * 4] + by);
  return copy;
};
const png = (data) => encodePng(W, H, data);

test('PNG encode/decode round-trips exactly', () => {
  const data = shifted(solid(10, 20, 30), 500, 77);
  const back = decodePng(png(data));
  assert.equal(back.width, W);
  assert.equal(back.height, H);
  assert.ok(back.data.equals(data));
});

test('identical images match with zero changed pixels', () => {
  const r = compareImages(png(solid(1, 2, 3)), png(solid(1, 2, 3)));
  assert.equal(r.status, 'match');
  assert.equal(r.diffPixels, 0);
  assert.equal(r.diffPng, undefined);
});

test('the pixel budget is exact: 50 changed pixels match, 51 fail', () => {
  const base = solid(200, 200, 200);
  assert.equal(compareImages(png(base), png(shifted(base, 50, 60))).status, 'match');
  const over = compareImages(png(base), png(shifted(base, 51, 60)));
  assert.equal(over.status, 'diff');
  assert.equal(over.diffPixels, 51);
  assert.ok(over.diffPng.length > 0 && over.triptychPng.length > 0);
});

test('anti-aliasing noise within the channel tolerance is ignored, one step beyond it is counted', () => {
  const base = solid(100, 100, 100);
  assert.equal(compareImages(png(base), png(shifted(base, 5000, 8)), { maxDiffPixels: 0 }).diffPixels, 0);
  assert.equal(compareImages(png(base), png(shifted(base, 5000, 9)), { maxDiffPixels: 0 }).diffPixels, 5000);
});

test('a change of dimensions is reported as such, never as a pixel diff', () => {
  const small = encodePng(10, 10, Buffer.alloc(10 * 10 * 4, 255));
  const r = compareImages(png(solid(0, 0, 0)), small);
  assert.equal(r.status, 'size-mismatch');
  assert.deepEqual(r.actual, { width: 10, height: 10 });
});

test('non-PNG input is refused loudly', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
});
