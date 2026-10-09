/**
 * Naming convention: a schema key `dbUrl` maps to env var `XO_DB_URL`.
 * Centralizing this mapping means the CLI's `xo config show` and the
 * loader always agree on where a value comes from.
 */
export function toEnvVarName(key: string, prefix = 'XO'): string {
  const snake = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // wordX -> word_X
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2') // ABCd -> AB_Cd (acronym boundary)
    .toUpperCase();
  return `${prefix}_${snake}`;
}
