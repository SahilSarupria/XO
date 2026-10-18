import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom does not lay anything out, so layout regressions found in browser QA are guarded at the rule level.
// Run from the package directory (npm workspace) or the repository root.
const cssPath = ['src/styles/app.css', 'apps/studio/src/styles/app.css'].map((p) => resolve(process.cwd(), p)).find(existsSync);
if (cssPath === undefined) throw new Error('app.css not found from ' + process.cwd());
const css = readFileSync(cssPath, 'utf8');
const rule = (selector: string): string => {
  const i = css.indexOf(`${selector} {`);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
};

describe('layout rules found necessary in browser QA', () => {
  it('a breadcrumb separator trails the previous item, so a wrapped line never starts with "/"', () => {
    expect(css).not.toMatch(/\.crumbs li \+ li::before/);
    expect(rule('.crumbs li:not(:last-child)::after')).toContain("content: '/'");
  });

  it('breadcrumb links are at least 24px tall', () => {
    expect(rule('.crumb-link')).toMatch(/min-height: 1\.5rem/);
  });

  it('wide tables scroll inside their own container instead of crushing columns', () => {
    expect(rule('.table')).toMatch(/min-width: 3\d(\.\d+)?rem/);
    expect(rule('.table-scroll')).toContain('overflow-x: auto');
    expect(rule('.table .nowrap')).toContain('white-space: nowrap');
    expect(rule('.table th,\n.table td')).not.toContain('overflow-wrap');
  });

  it('the mode switch fills its row with equal buttons, and secondary Start work actions are flush left', () => {
    expect(rule('.mode-switch .mode button')).toContain('flex: 1');
    expect(rule('.start .start-others')).toContain('padding-left: 0'); // must out-rank .plain, declared later
  });

  it('on narrow screens the page header drops the repeated workspace crumb and tightens, so the first action stays on screen', () => {
    const media = css.slice(css.indexOf('@media (max-width: 40rem) {\n  .page-head'));
    expect(media).toContain('.crumbs .crumb-low');
    expect(media).toContain('display: none');
    expect(rule('.page-head-top')).toContain('flex-wrap: nowrap');
  });

  it('a sideways-scrolling table explains itself on narrow screens only', () => {
    expect(rule('.scroll-hint')).toContain('display: none');
    const media = css.slice(css.lastIndexOf('@media (max-width: 40rem) {\n  .scroll-hint'));
    expect(media).toContain('display: block');
  });
});
