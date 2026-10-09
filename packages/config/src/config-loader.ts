import { ConfigError } from '@xo/errors';
import { ErrorCode } from '@xo/errors';
import { toEnvVarName } from './env.js';
import type { ConfigOf, ConfigSchema, FieldSpec } from './schema.js';

export interface LoadConfigOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly envPrefix?: string;
}

function parseField(key: string, spec: FieldSpec, raw: string | undefined): unknown {
  if (raw === undefined) {
    if (spec.default !== undefined) return spec.default;
    if (spec.required) {
      throw new ConfigError(ErrorCode.CONFIG_MISSING_KEY, `Missing required config key "${key}" (env ${toEnvVarName(key)})`);
    }
    return undefined;
  }

  switch (spec.type) {
    case 'string':
      return raw;
    case 'number': {
      const n = Number(raw);
      if (Number.isNaN(n)) {
        throw new ConfigError(ErrorCode.CONFIG_INVALID_VALUE, `Config key "${key}" must be a number, got "${raw}"`);
      }
      if (spec.min !== undefined && n < spec.min) {
        throw new ConfigError(ErrorCode.CONFIG_INVALID_VALUE, `Config key "${key}" must be >= ${spec.min}, got ${n}`);
      }
      if (spec.max !== undefined && n > spec.max) {
        throw new ConfigError(ErrorCode.CONFIG_INVALID_VALUE, `Config key "${key}" must be <= ${spec.max}, got ${n}`);
      }
      return n;
    }
    case 'boolean': {
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
      throw new ConfigError(ErrorCode.CONFIG_INVALID_VALUE, `Config key "${key}" must be a boolean (true/false/1/0), got "${raw}"`);
    }
    case 'enum': {
      if (!spec.values.includes(raw)) {
        throw new ConfigError(ErrorCode.CONFIG_INVALID_VALUE, `Config key "${key}" must be one of [${spec.values.join(', ')}], got "${raw}"`);
      }
      return raw;
    }
  }
}

/**
 * Resolves a config schema against environment variables. Throws
 * `ConfigError` (not a `Result`) on the first invalid/missing key, since an
 * invalid boot-time config is an unrecoverable startup failure, not a
 * per-request outcome a caller branches on — this is the exception to
 * @xo/types' "prefer Result" guidance, documented in
 * docs/CODING_STANDARDS.md.
 */
export function loadConfig<S extends ConfigSchema>(schema: S, options: LoadConfigOptions = {}): ConfigOf<S> {
  const env = options.env ?? process.env;
  const prefix = options.envPrefix ?? 'XO';
  const result: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schema)) {
    result[key] = parseField(key, spec, env[toEnvVarName(key, prefix)]);
  }
  return result as ConfigOf<S>;
}

/** Renders resolved config as `ENV_VAR=value` lines, for `xo config show`. Never renders values for keys whose name matches a secret-looking pattern. */
export function describeConfig<S extends ConfigSchema>(schema: S, config: ConfigOf<S>, envPrefix = 'XO'): string {
  const secretPattern = /secret|password|token|key$/i;
  return Object.keys(schema)
    .map((key) => {
      const envVar = toEnvVarName(key, envPrefix);
      const value = (config as Record<string, unknown>)[key];
      const rendered = secretPattern.test(key) ? '********' : JSON.stringify(value);
      return `${envVar}=${rendered}`;
    })
    .join('\n');
}
