/**
 * S1-1 — the design tokens hold their promises: every text and status colour reads at WCAG AA (4.5:1) on every surface in both
 * themes, control edges and the focus ring at 3:1, status text on its own wash at 4.5:1; and no stylesheet but tokens.css
 * names a colour.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const STYLES = join(__dirname, '../../src/styles');
const css = readFileSync(join(STYLES, 'tokens.css'), 'utf8');

function block(selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error(`no ${selector} block`);
  const open = css.indexOf('{', i);
  return css.slice(open + 1, css.indexOf('\n}', open));
}
function vars(b: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of b.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}
const light = vars(block(':root {'));
const themes: Record<string, Record<string, string>> = { light, dark: { ...light, ...vars(block(":root[data-theme='dark'] {")) } };

type Rgba = readonly [number, number, number, number];
function resolve(v: string, env: Record<string, string>, depth = 0): string {
  const m = /^var\((--[\w-]+)\)$/.exec(v.trim());
  if (m === null) return v.trim();
  if (depth > 10 || env[m[1]!] === undefined) throw new Error(`cannot resolve ${v}`);
  return resolve(env[m[1]!]!, env, depth + 1);
}
function parse(s: string): Rgba {
  if (s.startsWith('#') && s.length === 7) return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)).concat(1) as unknown as Rgba;
  const m = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(s);
  if (m === null) throw new Error(`not a colour: ${s}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}
const over = (fg: Rgba, bg: Rgba): Rgba => [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3])).concat(1) as unknown as Rgba;
function lum(c: Rgba): number {
  const ch = (x: number) => {
    const v = x / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
}
const ratio = (a: Rgba, b: Rgba) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

const SURFACES = ['--bg', '--surface-1', '--surface-2', '--surface-3'];
const TEXT = ['--text-1', '--text-2', '--text-3', '--accent', '--positive', '--attention', '--danger', '--person'];
const UI = ['--control-border', '--focus'];
const WASHES: [string, string][] = [
  ['--accent', '--accent-wash'],
  ['--positive', '--positive-wash'],
  ['--attention', '--attention-wash'],
  ['--danger', '--danger-wash'],
  ['--person', '--person-wash'],
  ['--text-2', '--neutral-wash'],
];

describe.each(Object.entries(themes))('%s theme contrast', (_name, env) => {
  const colour = (name: string, under?: Rgba): Rgba => {
    const c = parse(resolve(env[name] ?? `var(${name})`, env));
    return c[3] < 1 ? over(c, under ?? colour('--surface-1')) : c;
  };
  it.each(SURFACES.flatMap((s) => TEXT.map((t) => [t, s])))('text %s on %s is at least 4.5:1', (t, s) => {
    expect(ratio(colour(t), colour(s))).toBeGreaterThanOrEqual(4.5);
  });
  it.each(SURFACES.flatMap((s) => UI.map((t) => [t, s])))('UI part %s on %s is at least 3:1', (t, s) => {
    expect(ratio(colour(t), colour(s))).toBeGreaterThanOrEqual(3);
  });
  it.each(WASHES.flatMap(([t, w]) => ['--bg', '--surface-1'].map((s) => [t, w, s])))('%s on %s over %s is at least 4.5:1', (t, w, s) => {
    expect(ratio(colour(t), colour(w, colour(s)))).toBeGreaterThanOrEqual(4.5);
  });
  it('text on the accent is at least 4.5:1', () => {
    expect(ratio(colour('--accent-ink'), colour('--accent'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('no raw colours outside tokens.css', () => {
  const files = readdirSync(STYLES).filter((f) => f.endsWith('.css') && f !== 'tokens.css');
  it.each(files)('%s names no colour', (f) => {
    const text = readFileSync(join(STYLES, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const raw = [...text.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:white|black)\b(?![-\w])/g)].map((m) => m[0]);
    expect(raw).toEqual([]);
  });
});
