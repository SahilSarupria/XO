import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom lays nothing out, so the rules that make the live card safe are guarded at the rule level.
const path = ['src/styles/workflows.css', 'apps/studio/src/styles/workflows.css'].map((p) => resolve(process.cwd(), p)).find(existsSync)!;
const css = readFileSync(path, 'utf8');

describe('live card styling', () => {
  it('travels with an animation that people who ask for less motion do not get: the line is simply lit instead', () => {
    expect(css).toMatch(/\.wc\[data-live='true'\]::before \{[^}]*animation: wc-crawl/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.wc\[data-live='true'\]::before \{\s*animation: none;/);
  });

  it('the moving line never catches clicks: the card and its menu stay operable', () => {
    expect(css).toMatch(/\.wc\[data-live='true'\]::before \{[^}]*pointer-events: none/);
  });

  it('carries its own text colours, so it stays readable on a light page', () => {
    const rule = css.slice(css.indexOf(".wc[data-live='true'] {"), css.indexOf(".wc[data-live='true']:hover"));
    for (const token of ['--text:', '--text-muted:', '--border:', '--bg-sunken:']) expect(rule).toContain(token);
  });
});
