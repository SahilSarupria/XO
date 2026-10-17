import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LABEL = {
  match: 'matches',
  diff: 'CHANGED',
  'size-mismatch': 'SIZE CHANGED',
  'missing-baseline': 'NO APPROVED REFERENCE',
  functional: 'DID NOT BEHAVE AS EXPECTED',
  candidate: 'candidate written',
};

/** A short, scannable report. Written to the artifact folder and, in Actions, to the job summary. */
export function buildReport({ verdict, results, orphans, info, mode }) {
  const lines = [];
  lines.push(`# Studio visual regression — ${verdict.kind.toUpperCase()}`, '', verdict.headline, '');
  if (verdict.kind === 'infra') {
    lines.push('This is an **infrastructure failure**, not a visual regression: the suite could not finish, so the UI was not judged.', '');
  }
  if (verdict.kind === 'regression') {
    lines.push(
      'If these changes are intended, download the artifact, review `diff/*.side-by-side.png`, and follow “Updating approved references” in `docs/studio/VISUAL_REGRESSION.md`. Nothing is updated automatically.',
      '',
    );
  }
  if (results.length > 0 && results.every((r) => r.status === 'missing-baseline')) {
    lines.push(
      '**No approved references exist yet.** This is the expected first result before the references are bootstrapped: run this workflow manually with mode `update-candidates`, review the screenshots, and commit them (see “First-time setup” in `docs/studio/VISUAL_REGRESSION.md`).',
      '',
    );
  }
  if (mode === 'update-candidates') {
    lines.push(
      'Mode: **update-candidates**. New captures are in `candidates/`. Review them, then commit the ones you approve in a normal pull request.',
      '',
    );
  }
  if (results.length > 0) {
    lines.push('| Screen | Result | Changed pixels | Notes |', '| --- | --- | --- | --- |');
    for (const r of results) {
      const px = r.diffPixels === undefined || r.diffPixels === null ? '' : `${r.diffPixels} of ${r.totalPixels}`;
      const files = r.sideBySide === undefined ? '' : `\`${r.sideBySide}\``;
      lines.push(`| ${r.id} | ${LABEL[r.status] ?? r.status} | ${px} | ${[r.detail, files].filter(Boolean).join(' ')} |`);
    }
    lines.push('');
  }
  if (orphans.length > 0) {
    lines.push(
      `Approved references with no matching screen now (remove them deliberately if the screen was retired): ${orphans.map((o) => `\`${o}\``).join(', ')}`,
      '',
    );
  }
  lines.push('## Environment', '');
  for (const [k, v] of Object.entries(info)) lines.push(`- ${k}: ${v}`);
  lines.push('');
  return lines.join('\n');
}

export function writeReport(dir, args) {
  const markdown = buildReport(args);
  writeFileSync(join(dir, 'report.md'), markdown);
  writeFileSync(
    join(dir, 'result.json'),
    `${JSON.stringify({ result: args.verdict.kind, headline: args.verdict.headline, mode: args.mode, info: args.info, results: args.results, orphanedBaselines: args.orphans }, null, 2)}\n`,
  );
  return markdown;
}
