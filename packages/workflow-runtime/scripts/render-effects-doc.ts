// Regenerates the effect-state table in docs/EFFECTS.md from EFFECT_STATE_MAPPING (a test fails when they differ).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { effectMappingMarkdown } from '../src/effects.js';

const path = fileURLToPath(new URL('../../../docs/EFFECTS.md', import.meta.url));
const doc = readFileSync(path, 'utf8');
const begin = '<!-- effect-state-table:begin -->';
const end = '<!-- effect-state-table:end -->';
const i = doc.indexOf(begin);
const j = doc.indexOf(end);
if (i < 0 || j < i) throw new Error('docs/EFFECTS.md has no effect-state-table markers');
writeFileSync(path, `${doc.slice(0, i + begin.length)}\n${effectMappingMarkdown()}\n${doc.slice(j)}`);
process.stdout.write('docs/EFFECTS.md written\n');
