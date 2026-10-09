/**
 * Naming convention: a schema key `dbUrl` maps to env var `XO_DB_URL`.
 * Centralizing this mapping means the CLI's `xo config show` and the
 * loader always agree on where a value comes from.
 */
export declare function toEnvVarName(key: string, prefix?: string): string;
//# sourceMappingURL=env.d.ts.map