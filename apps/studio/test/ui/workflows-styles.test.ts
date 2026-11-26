import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom lays nothing out, so the rules that make the live card safe are guarded at the rule level.
const path = ['src/styles/workflows.css', 'apps/studio/src/styles/workflows.css'].map((p) => resolve(process.cwd(), p)).find(existsSync)!;
const css = readFileSync(path, 'utf8');

describe('live card styling', () => {
  const live = css.slice(css.indexOf(".wc[data-live='true'] {"));
  const rule = live.slice(0, live.indexOf('}'));

  it('is a steady accent edge on the normal card surface: nothing moves, so nothing needs a reduced-motion exception', () => {
    expect(rule).toContain('--accent');
    expect(css).not.toMatch(/wc-crawl|@property --wc-angle/);
    expect(css).not.toMatch(/\.wc\[data-live='true'\]::before/);
  });

  it('uses only theme tokens, so it reads the same way on a light and a dark page', () => {
    expect(css).not.toContain('--metal-');
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
