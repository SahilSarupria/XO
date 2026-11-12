import { CHANNEL_TOLERANCE, MAX_DIFF_PIXELS } from '../visual.config.mjs';
import { decodePng, encodePng } from './png.mjs';

/**
 * Compares an approved reference with a fresh capture.
 *
 * status:
 *   'match'          every difference is within the documented budget
 *   'diff'           more than `maxDiffPixels` pixels changed; `diffPng` and `triptychPng` are provided
 *   'size-mismatch'  the screen's dimensions changed (always a failure)
 */
export function compareImages(expectedPng, actualPng, options = {}) {
  const tolerance = options.channelTolerance ?? CHANNEL_TOLERANCE;
  const budget = options.maxDiffPixels ?? MAX_DIFF_PIXELS;
  const e = decodePng(expectedPng);
  const a = decodePng(actualPng);
  if (e.width !== a.width || e.height !== a.height) {
    return {
      status: 'size-mismatch',
      expected: { width: e.width, height: e.height },
      actual: { width: a.width, height: a.height },
      diffPixels: null,
      totalPixels: null,
    };
  }
  const total = e.width * e.height;
  const diff = Buffer.alloc(e.data.length);
  let changed = 0;
  for (let p = 0; p < total; p++) {
    const o = p * 4;
    const d = Math.max(
      Math.abs(e.data[o] - a.data[o]),
      Math.abs(e.data[o + 1] - a.data[o + 1]),
      Math.abs(e.data[o + 2] - a.data[o + 2]),
      Math.abs(e.data[o + 3] - a.data[o + 3]),
    );
    if (d > tolerance) {
      changed++;
      diff[o] = 255;
      diff[o + 1] = 0;
      diff[o + 2] = 255;
      diff[o + 3] = 255;
    } else {
      // Unchanged areas are shown faded so the changed pixels stand out.
      diff[o] = Math.round(e.data[o] * 0.3 + 178);
      diff[o + 1] = Math.round(e.data[o + 1] * 0.3 + 178);
      diff[o + 2] = Math.round(e.data[o + 2] * 0.3 + 178);
      diff[o + 3] = 255;
    }
  }
  const result = { status: changed > budget ? 'diff' : 'match', diffPixels: changed, totalPixels: total, diffRatio: changed / total };
  if (result.status === 'diff') {
    result.diffPng = encodePng(e.width, e.height, diff);
    result.triptychPng = triptych(e, a, { width: e.width, height: e.height, data: diff });
  }
  return result;
}

/** Reference | new capture | difference, side by side, so a reviewer sees everything in one image. */
function triptych(...panels) {
  const gap = 8;
  const { width, height } = panels[0];
  const w = width * panels.length + gap * (panels.length - 1);
  const out = Buffer.alloc(w * height * 4, 255);
  panels.forEach((panel, i) => {
    const x0 = i * (width + gap);
    for (let y = 0; y < height; y++) panel.data.copy(out, (y * w + x0) * 4, y * width * 4, (y + 1) * width * 4);
  });
  return encodePng(w, height, out);
}
