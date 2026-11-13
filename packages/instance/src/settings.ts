/**
 * UW-17 (ADR 0023, rule 1) — every setting an XO instance reads, in one place, validated at start-up.
 *
 * The registry is data: name, group, kind, default, what it does. `resolveSettings` reads the environment, an optional config file
 * and the instance data directory, and returns the effective environment together with EVERY problem found at once (a person fixing a
 * deployment should not have to restart once per typo). Names that look like XO settings but are not known are reported with the
 * closest known name. The features keep their own semantic parsers (OIDC, OCR, audit, ...); this layer catches shape errors, unknown
 * names and values a feature would otherwise silently read as "off".
 */

export type SettingGroup = 'server' | 'storage' | 'sign-in' | 'audit' | 'trust' | 'models' | 'reading' | 'workflows' | 'operations';

export type SettingKind =
  | { readonly type: 'string' }
  | { readonly type: 'path' }
  | { readonly type: 'url'; readonly httpsUnlessLoopback?: boolean }
  | { readonly type: 'integer'; readonly min: number; readonly max: number }
  | { readonly type: 'number'; readonly min: number; readonly max: number }
  /** A closed set of exact spellings. Anything else is refused (never silently read as off). */
  | { readonly type: 'enum'; readonly values: readonly string[] };

export interface SettingSpec {
  readonly name: string;
  readonly group: SettingGroup;
  readonly kind: SettingKind;
  readonly description: string;
  /** The value the feature uses when the setting is unset, as documentation. Not applied by this layer. */
  readonly defaultText?: string;
  /** A credential: never printed, and may come from the secret provider instead of the environment. */
  readonly secret?: boolean;
  /** Filled from `XO_DATA_DIR` (this path inside it) when unset, so all state lives in one directory. */
  readonly inDataDir?: string;
  /** Only filled from the data directory when every one of these settings is set (a feature that is off stays off). */
  readonly inDataDirWhen?: readonly string[];
  /** `cli`: read by the command-line tools, not by the instance. Known, so it is not reported as unknown. */
  readonly scope?: 'instance' | 'cli';
}

const FLAG_1 = { type: 'enum', values: ['1', 'true', '0', 'false'] } as const;
const ON_OFF = { type: 'enum', values: ['on', 'off'] } as const;
const PATH = { type: 'path' } as const;
const STR = { type: 'string' } as const;
const int = (min: number, max: number) => ({ type: 'integer', min, max }) as const;
const num = (min: number, max: number) => ({ type: 'number', min, max }) as const;

export const SETTINGS: readonly SettingSpec[] = [
  // ---------------------------------------------------------------- server
  { name: 'PORT', group: 'server', kind: int(1, 65535), defaultText: '4000', description: 'Port the instance listens on.' },
  {
    name: 'HOST',
    group: 'server',
    kind: STR,
    defaultText: '127.0.0.1',
    description: 'Address to listen on. Keep loopback unless a proxy you operate sits in front (a container needs 0.0.0.0).',
  },
  {
    name: 'XO_PUBLIC_BASE_URL',
    group: 'server',
    kind: { type: 'url', httpsUnlessLoopback: true },
    description:
      'The address people use to reach this instance (https, except on loopback). Printed by xo up, used for links, and its /auth/callback is an allowed sign-in return address.',
  },
  {
    name: 'XO_API_TRUSTED_PROXY_HOPS',
    group: 'server',
    kind: int(0, 5),
    defaultText: '0',
    description: 'Reverse proxies you control in front of the instance, so rate limits see the real client address.',
  },
  {
    name: 'XO_STUDIO_DIR',
    group: 'server',
    kind: PATH,
    description: 'A built Studio (apps/studio/dist) to serve at / on the same port, with the API under /api. Unset: API only.',
  },
  {
    name: 'XO_DEV_SIGN_IN',
    group: 'server',
    kind: FLAG_1,
    defaultText: '1',
    description: 'Show the access-key sign-in in the served Studio. Set 0 once another sign-in works.',
  },
  {
    name: 'XO_ENV',
    group: 'server',
    kind: { type: 'enum', values: ['development', 'test', 'production'] },
    defaultText: 'development',
    description: 'Deployment environment. production makes several safeguards mandatory.',
  },
  {
    name: 'NODE_ENV',
    group: 'server',
    kind: STR,
    description: 'production makes platform audit storage mandatory and refuses development package trust.',
  },
  {
    name: 'XO_LOG_LEVEL',
    group: 'operations',
    kind: { type: 'enum', values: ['debug', 'info', 'warn', 'error'] },
    defaultText: 'info',
    description: 'Least severe log line written to standard output (one JSON object per line).',
  },
  {
    name: 'XO_METRICS_TOKEN',
    group: 'operations',
    kind: STR,
    secret: true,
    description: 'Bearer token a metrics scraper sends to GET /metrics. Unset: /metrics is off.',
  },
  {
    name: 'XO_SCHEDULER',
    group: 'workflows',
    kind: ON_OFF,
    defaultText: 'on',
    description: 'Fire schedule triggers from this instance. One instance per data directory runs them.',
  },
  {
    name: 'XO_CONFIG_FILE',
    group: 'operations',
    kind: PATH,
    description: 'A KEY=VALUE settings file read at start-up (environment variables win). Default: xo.env in the data directory.',
  },

  // ---------------------------------------------------------------- storage (one data directory)
  {
    name: 'XO_DATA_DIR',
    group: 'storage',
    kind: PATH,
    description: 'The instance data directory. Every storage setting below defaults to a folder inside it.',
  },
  {
    name: 'API_KEYS_DIR',
    group: 'storage',
    kind: PATH,
    inDataDir: 'api-keys',
    defaultText: '.xo-data/api-keys',
    description: 'Access keys (hashes only).',
  },
  {
    name: 'WORKSPACES_DIR',
    group: 'storage',
    kind: PATH,
    inDataDir: 'workspaces',
    defaultText: '.xo-data/workspaces',
    description: 'Workspace records (who owns which workspace).',
  },
  {
    name: 'WORKSPACE_DATA_DIR',
    group: 'storage',
    kind: PATH,
    inDataDir: 'workspace-data',
    defaultText: '.xo-data/workspace-data',
    description: 'Everything inside workspaces: sources, compilations, packages, runs, workspace audit logs.',
  },
  {
    name: 'XO_API_SESSIONS_DIR',
    group: 'storage',
    kind: PATH,
    inDataDir: 'sessions',
    inDataDirWhen: ['XO_API_GOOGLE_CLIENT_ID'],
    description: 'Google sign-in sessions.',
  },
  {
    name: 'XO_API_ACCOUNTS_DIR',
    group: 'storage',
    kind: PATH,
    inDataDir: 'accounts',
    inDataDirWhen: ['XO_API_PASSWORD_AUTH'],
    description: 'Password sign-in accounts (argon2id hashes).',
  },
  {
    name: 'XO_API_PASSWORD_BINDINGS_DIR',
    group: 'storage',
    kind: PATH,
    inDataDir: 'oidc-bindings',
    inDataDirWhen: ['XO_API_PASSWORD_AUTH'],
    description: 'Password identity bindings (shared with Google sign-in, which requires the same folder).',
  },
  {
    name: 'XO_API_PASSWORD_SESSIONS_DIR',
    group: 'storage',
    kind: PATH,
    inDataDir: 'sessions',
    inDataDirWhen: ['XO_API_PASSWORD_AUTH'],
    description: 'Password sign-in sessions (shared with Google sign-in, which requires the same folder).',
  },
  {
    name: 'XO_API_OIDC_BINDINGS_DIR',
    group: 'storage',
    kind: PATH,
    inDataDir: 'oidc-bindings',
    description: 'Which organisation identity maps to which XO identity.',
  },
  {
    name: 'XO_AUDIT_DIR',
    group: 'audit',
    kind: PATH,
    inDataDir: 'audit',
    inDataDirWhen: ['XO_AUDIT_RETENTION_DAYS', 'XO_AUDIT_MIN_RETENTION_DAYS'],
    description: 'Durable platform audit store. Set with both retention settings, or none of them.',
  },
  {
    name: 'XO_EXTERNAL_EFFECTS_DIR',
    group: 'storage',
    kind: PATH,
    inDataDir: 'external-effects',
    description: 'Durable evidence of every external effect dispatched (one filesystem, shared by every worker).',
  },
  { name: 'XO_INFERENCE_CACHE_DIR', group: 'storage', kind: PATH, inDataDir: 'inference-cache', description: 'Cached model answers.' },
  {
    name: 'XO_SECRETS_FILE',
    group: 'storage',
    kind: PATH,
    inDataDir: 'secrets.enc',
    description: 'Encrypted secrets file (xo secrets set). Its key is kept outside the data directory.',
  },
  {
    name: 'XO_SECRETS_KEY_FILE',
    group: 'storage',
    kind: PATH,
    description: 'Where the key for the secrets file lives. Keep it out of the data directory and out of its backups.',
  },
  {
    name: 'XO_SECRETS_KEY',
    group: 'storage',
    kind: STR,
    secret: true,
    description: 'The secrets-file key itself (base64, 32 bytes), for hosts that inject it as an environment variable.',
  },

  // ---------------------------------------------------------------- sign-in
  { name: 'XO_API_OIDC_ISSUER', group: 'sign-in', kind: { type: 'url' }, description: 'Accept bearer tokens from this OIDC issuer.' },
  { name: 'XO_API_OIDC_AUDIENCE', group: 'sign-in', kind: STR, description: 'The audience those tokens must carry.' },
  { name: 'XO_API_OIDC_JWKS_URI', group: 'sign-in', kind: { type: 'url' }, description: 'The issuer signing keys.' },
  { name: 'XO_API_OIDC_CLOCK_SKEW_SECONDS', group: 'sign-in', kind: int(0, 120), defaultText: '30', description: 'Allowed clock skew.' },
  { name: 'XO_API_GOOGLE_CLIENT_ID', group: 'sign-in', kind: STR, description: 'Google sign-in OAuth client id (public).' },
  {
    name: 'XO_API_GOOGLE_CLIENT_SECRET',
    group: 'sign-in',
    kind: STR,
    secret: true,
    description: 'That client secret. Read by the instance only, to redeem sign-in codes.',
  },
  { name: 'XO_API_GOOGLE_ISSUER', group: 'sign-in', kind: { type: 'url' }, description: 'Override of the Google issuer (tests).' },
  { name: 'XO_API_GOOGLE_JWKS_URI', group: 'sign-in', kind: { type: 'url' }, description: 'Override of the Google signing keys (tests).' },
  {
    name: 'XO_API_GOOGLE_TOKEN_URI',
    group: 'sign-in',
    kind: { type: 'url' },
    description: 'Override of the Google token endpoint (tests).',
  },
  {
    name: 'XO_API_SELF_SIGNUP',
    group: 'sign-in',
    kind: FLAG_1,
    defaultText: '0',
    description: 'Anyone with a verified account may sign in.',
  },
  {
    name: 'XO_API_SELF_SIGNUP_MAX_PER_DAY',
    group: 'sign-in',
    kind: int(1, 1_000_000),
    defaultText: '200',
    description: 'New self-created accounts per rolling 24 hours.',
  },
  { name: 'XO_API_PASSWORD_AUTH', group: 'sign-in', kind: FLAG_1, defaultText: '0', description: 'Offer password sign-in.' },
  {
    name: 'XO_API_PASSWORD_HASH_CONCURRENCY',
    group: 'sign-in',
    kind: int(1, 16),
    defaultText: '2',
    description: 'Parallel password hashes.',
  },
  { name: 'XO_API_PASSWORD_HASH_QUEUE_LIMIT', group: 'sign-in', kind: int(0, 1024), defaultText: '32', description: 'Waiting hashes.' },
  { name: 'XO_API_PASSWORD_ARGON2_TIME_COST', group: 'sign-in', kind: int(2, 10), defaultText: '3', description: 'argon2id time cost.' },
  {
    name: 'XO_API_PASSWORD_ARGON2_MEMORY_KIB',
    group: 'sign-in',
    kind: int(19_456, 1_048_576),
    defaultText: '65536',
    description: 'argon2id memory cost.',
  },
  {
    name: 'XO_API_KEY_MAX_AGE_DAYS',
    group: 'sign-in',
    kind: int(1, 3650),
    defaultText: '365',
    description: 'Maximum age of an access key issued without an expiry.',
  },
  {
    name: 'XO_API_STEP_UP_MAX_AGE_MINUTES',
    group: 'sign-in',
    kind: int(0, 1440),
    defaultText: '15',
    description: 'Approvals and membership changes need a sign-in this recent (0 turns step-up off).',
  },

  // ---------------------------------------------------------------- audit
  {
    name: 'XO_API_AUDIT_RETENTION_DAYS',
    group: 'audit',
    kind: int(1, 36500),
    description: 'Declared retention of workspace audit logs. Unset: none declared, nothing may be purged.',
  },
  { name: 'XO_AUDIT_RETENTION_DAYS', group: 'audit', kind: num(0.001, 36500), description: 'Platform audit default retention (days).' },
  { name: 'XO_AUDIT_MIN_RETENTION_DAYS', group: 'audit', kind: num(0.001, 36500), description: 'Platform audit minimum retention (days).' },
  {
    name: 'XO_AUDIT_ANCHOR_DIR',
    group: 'audit',
    kind: PATH,
    description:
      'Where each workspace audit chain head is anchored. Put it on storage this host cannot rewrite, never inside the data directory.',
  },

  // ---------------------------------------------------------------- trust
  {
    name: 'XO_TRUST_MODE',
    group: 'trust',
    kind: { type: 'enum', values: ['enforce', 'development'] },
    defaultText: 'enforce',
    description: 'development turns package signature verification off (local development only).',
  },
  { name: 'XO_PACKAGE_TRUST_POLICY', group: 'trust', kind: PATH, description: 'The package trust policy file (trusted signers).' },

  // ---------------------------------------------------------------- residency (UW-14)
  {
    name: 'XO_RESIDENCY',
    group: 'models',
    kind: { type: 'enum', values: ['strict_local', 'masked_hosted', 'open'] },
    defaultText: 'strict_local',
    description:
      'Where data may go when a model is asked something. strict_local: no hosted model or vision call is possible (models on this server only). masked_hosted: contracted hosted providers, typed requests only (schemas, synthetic records, filtered intent). open: anything; development only, refused in production.',
  },
  {
    name: 'XO_HOSTED_MODEL_PROVIDERS',
    group: 'models',
    kind: STR,
    description:
      'masked_hosted only: comma-separated hosted providers whose paid, no-training contract you have reviewed (for example anthropic).',
  },

  // ---------------------------------------------------------------- models
  {
    name: 'XO_INFERENCE_PROVIDER',
    group: 'models',
    kind: { type: 'enum', values: ['none', 'gemini'] },
    defaultText: 'none',
    description: 'Compile-time inference provider.',
  },
  { name: 'GEMINI_API_KEY', group: 'models', kind: STR, secret: true, description: 'Gemini key.' },
  { name: 'XO_GEMINI_MODEL', group: 'models', kind: STR, description: 'Gemini model id.' },
  { name: 'XO_GEMINI_TIMEOUT_MS', group: 'models', kind: int(1000, 300_000), defaultText: '30000', description: 'Gemini request timeout.' },
  { name: 'XO_GEMINI_MAX_OUTPUT_TOKENS', group: 'models', kind: int(1, 65_536), defaultText: '8192', description: 'Output token cap.' },
  { name: 'XO_GEMINI_TEMPERATURE', group: 'models', kind: num(0, 2), description: 'Default temperature.' },
  { name: 'XO_GEMINI_MAX_RETRIES', group: 'models', kind: int(0, 5), defaultText: '2', description: 'Retries after the first attempt.' },
  {
    name: 'XO_GEMINI_ACK_DATA_USE_TERMS',
    group: 'models',
    kind: FLAG_1,
    defaultText: 'false',
    description: 'Required in production: you checked Google data-use terms for your key tier.',
  },
  { name: 'ANTHROPIC_API_KEY', group: 'models', kind: STR, secret: true, description: 'Anthropic key (chat, vision reading).' },
  { name: 'OPENAI_API_KEY', group: 'models', kind: STR, secret: true, description: 'OpenAI key.' },
  { name: 'AZURE_OPENAI_API_KEY', group: 'models', kind: STR, secret: true, description: 'Azure OpenAI key.' },
  { name: 'AZURE_OPENAI_ENDPOINT', group: 'models', kind: { type: 'url' }, description: 'Azure OpenAI endpoint.' },
  { name: 'OLLAMA_BASE_URL', group: 'models', kind: { type: 'url' }, description: 'A local Ollama server.' },
  { name: 'XO_API_OLLAMA_ENABLED', group: 'models', kind: FLAG_1, description: 'Offer Ollama at its default address.' },
  { name: 'XO_COMPILER_MAX_COST_USD', group: 'models', kind: num(0, 10_000), description: 'Spend limit per compile.' },
  { name: 'XO_COMPILER_MAX_TOTAL_TOKENS', group: 'models', kind: int(1, 1_000_000_000), description: 'Token limit per compile.' },
  {
    name: 'XO_COMPILER_ALLOW_UNBOUNDED_INFERENCE',
    group: 'models',
    kind: FLAG_1,
    description: 'Compile with inference and no spend limit (explicit only).',
  },
  {
    name: 'XO_COMPILER_ESCALATION_MODE',
    group: 'models',
    kind: { type: 'enum', values: ['gated', 'always'] },
    defaultText: 'gated',
    description: 'When the compiler asks a model.',
  },
  { name: 'XO_COMPILER_ESCALATION_CONFIDENCE_THRESHOLD', group: 'models', kind: num(0, 1), description: 'Escalation confidence floor.' },
  { name: 'XO_COMPILER_ESCALATION_AMBIGUITY_MARGIN', group: 'models', kind: num(0, 1), description: 'Escalation ambiguity margin.' },
  { name: 'XO_COMPILER_ESCALATION_MIN_CONTENT_WORDS', group: 'models', kind: int(0, 100_000), description: 'Escalation minimum words.' },

  // ---------------------------------------------------------------- reading scans and photos
  {
    name: 'XO_OCR',
    group: 'reading',
    kind: { type: 'enum', values: ['local', 'off'] },
    defaultText: 'local',
    description: 'Read scanned pages and photos on this machine.',
  },
  { name: 'XO_OCR_WORKERS', group: 'reading', kind: int(1, 16), defaultText: '2', description: 'OCR worker threads.' },
  { name: 'XO_OCR_VISION_PROVIDER', group: 'reading', kind: STR, description: 'Vision reading provider (off unless set).' },
  { name: 'XO_OCR_VISION_MODEL', group: 'reading', kind: STR, description: 'Vision reading model.' },
  {
    name: 'XO_OCR_VISION_SENDS_IMAGES',
    group: 'reading',
    kind: { type: 'enum', values: ['yes'] },
    description: 'Confirms page images and photos may be sent to the vision provider.',
  },
  { name: 'XO_OCR_MAX_COST_USD', group: 'reading', kind: num(0, 100), defaultText: '0', description: 'Vision spend per document.' },

  // ---------------------------------------------------------------- workflows
  {
    name: 'XO_PROCEDURE_STEP_TIMEOUT_MS',
    group: 'workflows',
    kind: int(1, 9_999_999_999),
    description: 'Per-step timeout for procedures. Unset: none.',
  },
  { name: 'XO_API_RUNTIME_LOCATIONS', group: 'workflows', kind: STR, description: 'Where workflows may run, as shown in settings.' },
  { name: 'XO_SANDBOX_NET_GUARD', group: 'workflows', kind: FLAG_1, description: 'Set by the sandbox for its own workers.' },
  { name: 'XO_SANDBOX_TEST_HOOKS', group: 'workflows', kind: STR, description: 'Test-only sandbox hooks.' },

  // ---------------------------------------------------------------- command-line tools (known, not instance settings)
  ...[
    'XO_HOME',
    'XO_TOKEN_FILE',
    'XO_SERVER_TOKEN',
    'XO_WEBHOOK_SECRET',
    'XO_WEBHOOK_TLS_CERT',
    'XO_WEBHOOK_TLS_KEY',
    'XO_WEBHOOK_BEHIND_TLS_PROXY',
    'XO_APPROVAL_URL',
    'XO_APPROVAL_SECRET',
    'XO_DELIVERY_URL',
    'XO_DELIVERY_SECRET',
    'XO_ANCHOR_URL',
    'XO_ANCHOR_SECRET',
    'XO_PROVIDER',
    'XO_MODEL',
    'XO_PROVIDER_BASE_URL',
    'XO_EXTRACTOR_PROVIDER',
    'XO_EXTRACTOR_MODEL',
    'XO_EXTRACTOR_BASE_URL',
    'XO_ALLOW_CUSTOM_ENDPOINT',
    'XO_CONFIG_DIR',
    'XO_GEMINI_THINKING_BUDGET',
    'XO_INFERENCE_ALLOW_UNDECLARED',
    'XO_SANDBOX_NETWORK',
    'XO_DB_URL',
    'XO_OIDC_ISSUER',
    'XO_OIDC_CLIENT_ID',
    'XO_API_URL',
  ].map((name): SettingSpec => ({ name, group: 'operations', kind: STR, scope: 'cli', description: 'Read by the command-line tools.' })),
];

/** Families read by prefix (connector secrets for the CLI's flow runner). */
const KNOWN_PREFIXES: readonly string[] = ['XO_SECRET_'];

const BY_NAME: ReadonlyMap<string, SettingSpec> = new Map(SETTINGS.map((s) => [s.name, s]));

export function settingSpec(name: string): SettingSpec | undefined {
  return BY_NAME.get(name);
}

export type Env = Readonly<Record<string, string | undefined>>;

export interface SettingsProblem {
  readonly name: string;
  readonly message: string;
}

export interface ResolvedSettings {
  /** The effective environment: the process environment, then the config file, then data-directory defaults. */
  readonly env: Readonly<Record<string, string>>;
  /** Where each effective value came from. */
  readonly sources: Readonly<Record<string, 'environment' | 'config-file' | 'data-dir' | 'secrets'>>;
  readonly errors: readonly SettingsProblem[];
  readonly warnings: readonly SettingsProblem[];
  readonly configFile?: string;
  readonly dataDir?: string;
}

export interface ResolveSettingsOptions {
  /** Contents of the config file, already read (the caller owns I/O). */
  readonly configFile?: { readonly path: string; readonly text: string };
  /** Secrets from the secret provider, applied only where the environment and config file leave a secret unset. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** `path.join`-like, injected so this module stays pure. */
  readonly joinPath: (...parts: string[]) => string;
}

/** `KEY=VALUE` lines; `#` comments; optional matching quotes; `export ` prefix tolerated. Problems are reported, not skipped silently. */
export function parseEnvFile(text: string): { readonly values: Record<string, string>; readonly problems: readonly string[] } {
  const values: Record<string, string> = {};
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m === null) {
      problems.push(`line ${i + 1} is not KEY=VALUE`);
      return;
    }
    let v = m[2]!;
    const quoted = /^(['"])(.*)\1$/.exec(v);
    if (quoted !== null) v = quoted[2]!;
    else v = v.replace(/\s+#.*$/, '').trim();
    if (values[m[1]!] !== undefined) problems.push(`line ${i + 1}: ${m[1]} is set twice; the later value is used`);
    values[m[1]!] = v;
  });
  return { values, problems };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function checkValue(spec: SettingSpec, raw: string): string | undefined {
  const v = raw.trim();
  if (v !== raw && spec.kind.type !== 'string') return 'has leading or trailing spaces';
  if (/[\u0000-\u001f\u007f]/.test(raw)) return 'contains control characters (a stray newline from copying?)';
  switch (spec.kind.type) {
    case 'string':
    case 'path':
      return undefined;
    case 'url': {
      let u: URL;
      try {
        u = new URL(v);
      } catch {
        return 'is not a valid URL';
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'must be an http(s) URL';
      if (u.username !== '' || u.password !== '') return 'must not contain credentials';
      if (spec.kind.httpsUnlessLoopback === true && u.protocol !== 'https:' && !LOOPBACK_HOSTS.has(u.hostname))
        return 'must be https (plain http is only allowed on loopback)';
      return undefined;
    }
    case 'integer': {
      if (!/^-?\d+$/.test(v)) return `must be a whole number from ${spec.kind.min} to ${spec.kind.max}`;
      const n = Number(v);
      return n < spec.kind.min || n > spec.kind.max ? `must be a whole number from ${spec.kind.min} to ${spec.kind.max}` : undefined;
    }
    case 'number': {
      const n = Number(v);
      if (v === '' || !Number.isFinite(n) || n < spec.kind.min || n > spec.kind.max)
        return `must be a number from ${spec.kind.min} to ${spec.kind.max}`;
      return undefined;
    }
    case 'enum':
      return spec.kind.values.includes(v) ? undefined : `must be one of: ${spec.kind.values.join(', ')}`;
  }
}

/** Plain Levenshtein, for "did you mean". */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

export function closestSetting(name: string): string | undefined {
  let best: { name: string; d: number } | undefined;
  for (const s of SETTINGS) {
    const d = distance(name, s.name);
    if (best === undefined || d < best.d) best = { name: s.name, d };
  }
  return best !== undefined && best.d <= Math.max(2, Math.floor(name.length / 5)) ? best.name : undefined;
}

/** A setting that turns a feature on counts as on when set to anything but empty, 0, false or off. */
const featureOn = (v: string | undefined): boolean => v !== undefined && !['', '0', 'false', 'off'].includes(v.trim().toLowerCase());

const looksLikeOurs = (name: string): boolean => name.startsWith('XO_') && !KNOWN_PREFIXES.some((p) => name.startsWith(p));

export function resolveSettings(processEnv: Env, options: ResolveSettingsOptions): ResolvedSettings {
  const errors: SettingsProblem[] = [];
  const warnings: SettingsProblem[] = [];
  const env: Record<string, string> = {};
  const sources: Record<string, 'environment' | 'config-file' | 'data-dir' | 'secrets'> = {};

  for (const [k, v] of Object.entries(processEnv)) {
    if (v === undefined) continue;
    env[k] = v;
    sources[k] = 'environment';
  }
  if (options.configFile !== undefined) {
    const parsed = parseEnvFile(options.configFile.text);
    for (const p of parsed.problems) warnings.push({ name: 'XO_CONFIG_FILE', message: `${options.configFile.path}: ${p}` });
    for (const [k, v] of Object.entries(parsed.values)) {
      if (env[k] !== undefined) continue; // the environment wins
      env[k] = v;
      sources[k] = 'config-file';
      if (settingSpec(k)?.secret === true)
        warnings.push({
          name: k,
          message: `is a secret kept in plain text in ${options.configFile.path}; move it with "xo secrets set ${k}"`,
        });
    }
  }
  for (const [k, v] of Object.entries(options.secrets ?? {})) {
    if (settingSpec(k)?.secret !== true) {
      warnings.push({ name: k, message: 'is in the secrets file but is not a secret setting; it is ignored' });
      continue;
    }
    if (env[k] !== undefined) continue;
    env[k] = v;
    sources[k] = 'secrets';
  }

  const dataDir = env['XO_DATA_DIR'];
  if (dataDir !== undefined && dataDir.trim() !== '') {
    for (const s of SETTINGS) {
      if (s.inDataDir === undefined || (env[s.name] ?? '').trim() !== '') continue;
      if (s.inDataDirWhen !== undefined && !s.inDataDirWhen.every((n) => featureOn(env[n]))) continue;
      env[s.name] = options.joinPath(dataDir, s.inDataDir);
      sources[s.name] = 'data-dir';
    }
  }

  for (const [name, value] of Object.entries(env)) {
    // An empty value means unset everywhere in XO (`FOO=` in an env file, `${FOO:-}` in compose): nothing to check.
    if (value.trim() === '') continue;
    const spec = settingSpec(name);
    if (spec === undefined) {
      if (looksLikeOurs(name)) {
        const near = closestSetting(name);
        warnings.push({ name, message: `is not an XO setting${near !== undefined ? ` (did you mean ${near}?)` : ''}; it is ignored` });
      }
      continue;
    }
    if (spec.scope === 'cli') continue;
    const problem = checkValue(spec, value);
    // Only values that cannot carry a credential are echoed (numbers, choices, paths); a URL may embed one, a string may be one.
    const echo = spec.secret !== true && ['integer', 'number', 'enum', 'path'].includes(spec.kind.type);
    if (problem !== undefined) errors.push({ name, message: `${problem}${echo ? ` (got "${value.slice(0, 80)}")` : ''}` });
  }

  // Cross-setting rules that would otherwise surface one restart at a time.
  const auditSet = ['XO_AUDIT_DIR', 'XO_AUDIT_RETENTION_DAYS', 'XO_AUDIT_MIN_RETENTION_DAYS'].filter((n) => (env[n] ?? '') !== '');
  if (auditSet.length !== 0 && auditSet.length !== 3)
    errors.push({
      name: 'XO_AUDIT_DIR',
      message:
        'is one of three platform audit settings (with XO_AUDIT_RETENTION_DAYS and XO_AUDIT_MIN_RETENTION_DAYS) that must all be set together, or none (with XO_DATA_DIR, the folder is filled in)',
    });
  const anchor = env['XO_AUDIT_ANCHOR_DIR'];
  if (anchor !== undefined && dataDir !== undefined && isInside(anchor, dataDir))
    errors.push({
      name: 'XO_AUDIT_ANCHOR_DIR',
      message: 'must be outside the data directory (an anchor next to the log it attests proves nothing)',
    });
  const keyFile = env['XO_SECRETS_KEY_FILE'];
  if (keyFile !== undefined && dataDir !== undefined && isInside(keyFile, dataDir))
    errors.push({
      name: 'XO_SECRETS_KEY_FILE',
      message: 'must be outside the data directory, so a copy of the data is not also a copy of its key',
    });
  // Rules the instance would otherwise only hit after creating its data directory.
  if (env['NODE_ENV'] === 'production' && auditSet.length === 0)
    errors.push({
      name: 'XO_AUDIT_RETENTION_DAYS',
      message:
        'is required in production, with XO_AUDIT_MIN_RETENTION_DAYS (and XO_AUDIT_DIR unless XO_DATA_DIR is set): no audit retention is assumed',
    });
  if (env['XO_TRUST_MODE'] !== 'development' && (env['XO_PACKAGE_TRUST_POLICY'] ?? '').trim() === '')
    errors.push({
      name: 'XO_PACKAGE_TRUST_POLICY',
      message:
        'is required: name the operator trust-policy file (for local development only, XO_TRUST_MODE=development turns verification off)',
    });
  if (env['XO_RESIDENCY'] === 'open' && (env['XO_ENV'] === 'production' || env['NODE_ENV'] === 'production'))
    errors.push({
      name: 'XO_RESIDENCY',
      message: 'open is for development only and is refused in production (use strict_local or masked_hosted)',
    });
  if (env['XO_RESIDENCY'] === 'masked_hosted' && (env['XO_HOSTED_MODEL_PROVIDERS'] ?? '').trim() === '')
    errors.push({
      name: 'XO_HOSTED_MODEL_PROVIDERS',
      message: 'is required with XO_RESIDENCY=masked_hosted: name the hosted providers whose contract you have reviewed',
    });
  if ((env['XO_HOSTED_MODEL_PROVIDERS'] ?? '').trim() !== '' && env['XO_RESIDENCY'] !== 'masked_hosted')
    warnings.push({ name: 'XO_HOSTED_MODEL_PROVIDERS', message: 'is ignored unless XO_RESIDENCY=masked_hosted' });
  if (env['XO_ENV'] === 'production' && env['XO_TRUST_MODE'] === 'development')
    errors.push({ name: 'XO_TRUST_MODE', message: 'development package trust is refused when XO_ENV=production' });

  return {
    env,
    sources,
    errors,
    warnings,
    ...(options.configFile !== undefined ? { configFile: options.configFile.path } : {}),
    ...(dataDir !== undefined ? { dataDir } : {}),
  };
}

function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}/`);
}

/** For `xo config check`: each instance setting with its effective value (secrets redacted) and where it came from. */
export function describeSettings(resolved: ResolvedSettings): readonly {
  readonly name: string;
  readonly group: SettingGroup;
  readonly value?: string;
  readonly source?: string;
  readonly defaultText?: string;
}[] {
  return SETTINGS.filter((s) => s.scope !== 'cli').map((s) => {
    const value = resolved.env[s.name];
    return {
      name: s.name,
      group: s.group,
      ...(value !== undefined ? { value: s.secret === true ? '(set, hidden)' : value, source: resolved.sources[s.name] } : {}),
      ...(s.defaultText !== undefined ? { defaultText: s.defaultText } : {}),
    };
  });
}

/** The configuration reference (docs/CONFIGURATION.md), generated so it cannot drift from what the instance accepts. */
export function renderConfigurationReference(): string {
  const groups: readonly [SettingGroup, string][] = [
    ['server', 'Server'],
    ['storage', 'Storage (one data directory)'],
    ['sign-in', 'Sign-in'],
    ['audit', 'Audit'],
    ['trust', 'Package trust'],
    ['models', 'Models'],
    ['reading', 'Reading scans and photos'],
    ['workflows', 'Workflows'],
    ['operations', 'Operations'],
  ];
  const kindText = (k: SettingKind): string => {
    switch (k.type) {
      case 'integer':
      case 'number':
        return `${k.type} ${k.min}–${k.max}`;
      case 'enum':
        return k.values.join(' \\| ');
      case 'url':
        return k.httpsUnlessLoopback === true ? 'https URL' : 'URL';
      default:
        return k.type;
    }
  };
  const out: string[] = [
    '# Configuration reference',
    '',
    '<!-- Generated from packages/instance/src/settings.ts by `node --import tsx packages/instance/scripts/render-config-doc.ts`. Do not edit by hand. -->',
    '',
    'Every setting an XO instance reads. Settings come from environment variables, then the config file (`XO_CONFIG_FILE`, default',
    '`xo.env` in the data directory), then the encrypted secrets file for secrets. The instance checks all of them at start-up and',
    'reports every problem at once; a name that looks like an XO setting but is not one is reported with the closest known name.',
    '',
    'With `XO_DATA_DIR` set, every storage setting defaults to a folder inside it ("In data dir" below), so one directory holds all',
    'state. A storage setting for a feature that is off stays unset.',
  ];
  for (const [group, title] of groups) {
    const rows = SETTINGS.filter((s) => s.group === group && s.scope !== 'cli');
    if (rows.length === 0) continue;
    out.push('', `## ${title}`, '', '| Setting | Accepts | Default | In data dir | What it does |', '| --- | --- | --- | --- | --- |');
    for (const s of rows)
      out.push(
        `| \`${s.name}\`${s.secret === true ? ' (secret)' : ''} | ${kindText(s.kind)} | ${s.defaultText ?? ''} | ${s.inDataDir !== undefined ? `\`${s.inDataDir}\`` : ''} | ${s.description.replace(/\|/g, '\\|')} |`,
      );
  }
  out.push(
    '',
    '## Read by the command-line tools',
    '',
    SETTINGS.filter((s) => s.scope === 'cli')
      .map((s) => `\`${s.name}\``)
      .join(', ') + '. The instance knows these names and does not report them as unknown.',
    '',
  );
  return out.join('\n');
}
