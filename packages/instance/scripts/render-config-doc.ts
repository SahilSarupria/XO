// Regenerates docs/CONFIGURATION.md from the settings registry (a test fails when they differ).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderConfigurationReference } from '../src/settings.js';

writeFileSync(fileURLToPath(new URL('../../../docs/CONFIGURATION.md', import.meta.url)), renderConfigurationReference());
process.stdout.write('docs/CONFIGURATION.md written\n');
