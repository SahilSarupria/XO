import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
/**
 * Loads a JSON fixture relative to the calling test file. Pass
 * `import.meta.url` from the test so fixtures resolve correctly regardless
 * of the working directory the test runner was invoked from.
 */
export async function loadJsonFixture(importMetaUrl, relativePath) {
    const dir = dirname(fileURLToPath(importMetaUrl));
    const raw = await readFile(join(dir, relativePath), 'utf8');
    return JSON.parse(raw);
}
//# sourceMappingURL=fixtures.js.map