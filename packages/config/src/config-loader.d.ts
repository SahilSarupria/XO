import type { ConfigOf, ConfigSchema } from './schema.js';
export interface LoadConfigOptions {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly envPrefix?: string;
}
/**
 * Resolves a config schema against environment variables. Throws
 * `ConfigError` (not a `Result`) on the first invalid/missing key, since an
 * invalid boot-time config is an unrecoverable startup failure, not a
 * per-request outcome a caller branches on — this is the exception to
 * @xo/types' "prefer Result" guidance, documented in
 * docs/CODING_STANDARDS.md.
 */
export declare function loadConfig<S extends ConfigSchema>(schema: S, options?: LoadConfigOptions): ConfigOf<S>;
/** Renders resolved config as `ENV_VAR=value` lines, for `xo config show`. Never renders values for keys whose name matches a secret-looking pattern. */
export declare function describeConfig<S extends ConfigSchema>(schema: S, config: ConfigOf<S>, envPrefix?: string): string;
//# sourceMappingURL=config-loader.d.ts.map