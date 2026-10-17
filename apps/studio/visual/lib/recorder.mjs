import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compareImages } from './compare.mjs';

/**
 * Collects one result per screen. It only ever WRITES under `outDir`; the approved references in `baselinesDir` are read
 * and never modified, whatever the mode.
 *
 *   mode 'compare'            compare each capture with its approved reference
 *   mode 'update-candidates'  save each capture as a proposed new reference under outDir/candidates (nothing is compared)
 */
export class Recorder {
  constructor({ outDir, baselinesDir, mode }) {
    this.outDir = outDir;
    this.baselinesDir = baselinesDir;
    this.mode = mode;
    this.results = [];
  }

  #write(rel, bytes) {
    const file = join(this.outDir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return rel;
  }

  submit(viewport, name, png) {
    const id = `${viewport}/${name}`;
    const actual = this.#write(`actual/${id}.png`, png);
    if (this.mode === 'update-candidates') {
      this.results.push({ id, status: 'candidate', actual, candidate: this.#write(`candidates/${id}.png`, png) });
      return;
    }
    const baseline = join(this.baselinesDir, `${id}.png`);
    if (!existsSync(baseline)) {
      this.results.push({ id, status: 'missing-baseline', actual, detail: 'No approved reference exists for this screen.' });
      return;
    }
    let cmp;
    try {
      cmp = compareImages(readFileSync(baseline), png);
    } catch (e) {
      // An unreadable reference is a problem with the approved file, not with this capture.
      this.results.push({ id, status: 'diff', actual, detail: `The approved reference could not be read: ${e.message}` });
      return;
    }
    const record = { id, status: cmp.status, actual, diffPixels: cmp.diffPixels, totalPixels: cmp.totalPixels };
    if (cmp.status === 'size-mismatch') {
      record.detail = `Size changed from ${cmp.expected.width}x${cmp.expected.height} to ${cmp.actual.width}x${cmp.actual.height}.`;
    }
    if (cmp.diffPng !== undefined) {
      record.diff = this.#write(`diff/${id}.png`, cmp.diffPng);
      record.sideBySide = this.#write(`diff/${id}.side-by-side.png`, cmp.triptychPng);
    }
    this.results.push(record);
  }

  /**
   * The UI loaded but did not behave as expected. Counts as a regression, not an infrastructure problem.
   * `png` (optional) is what the page looked like at that moment, kept under failures/ so a reviewer can see why.
   */
  functionalFailure(viewport, name, detail, png) {
    const id = `${viewport}/${name}`;
    const record = { id, status: 'functional', detail };
    if (png !== undefined) record.failureShot = this.#write(`failures/${id}.png`, png);
    this.results.push(record);
  }

  /** Approved references that no screen produced any more (a screen was removed or renamed). Reported, not failed. */
  orphanedBaselines() {
    if (this.mode !== 'compare' || !existsSync(this.baselinesDir)) return [];
    const seen = new Set(this.results.map((r) => `${r.id}.png`));
    const found = [];
    for (const viewport of readdirSync(this.baselinesDir, { withFileTypes: true })) {
      if (!viewport.isDirectory()) continue;
      for (const f of readdirSync(join(this.baselinesDir, viewport.name))) {
        if (f.endsWith('.png') && !seen.has(`${viewport.name}/${f}`)) found.push(`${viewport.name}/${f}`);
      }
    }
    return found.sort();
  }
}
