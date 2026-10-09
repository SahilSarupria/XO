import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function versionCommand(): string {
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(cliDir, '..', '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return `xo ${pkg.version}`;
}
