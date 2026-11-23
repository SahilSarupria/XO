/**
 * UW-17 (ADR 0054) — the one config file of a cloud instance (`xo-instance/1`), parsed and validated with the instance's own settings
 * registry. Every problem is listed at once. Values of secrets are never part of it: only their names.
 */
import { parse } from 'yaml';
import { resolveSettings, settingSpec } from '../settings.js';

export type DeploySize = 'small' | 'medium' | 'large';

export interface InstanceDeployConfig {
  readonly format: 'xo-instance/1';
  readonly name: string;
  readonly domain: string;
  readonly acmeEmail: string;
  readonly image: string;
  readonly size: DeploySize;
  readonly dataVolumeGi: number;
  readonly settings: Readonly<Record<string, string>>;
  readonly secrets: readonly { readonly name: string; readonly kubernetesSecret?: string }[];
  readonly kubernetes?: {
    readonly namespace: string;
    readonly storageClass?: string;
    readonly ingressClass?: string;
    readonly tlsSecret?: string;
    readonly certManagerIssuer?: string;
  };
  readonly backup?: { readonly keepDays: number };
}

export type ConfigResult =
  { readonly ok: true; readonly config: InstanceDeployConfig } | { readonly ok: false; readonly problems: string[] };

/** Fixed by the template: the container's own layout. A config may not set them. */
export const FIXED_SETTINGS: Readonly<Record<string, string>> = {
  NODE_ENV: 'production',
  XO_ENV: 'production',
  XO_DATA_DIR: '/data',
  XO_AUDIT_ANCHOR_DIR: '/anchors',
  XO_SECRETS_KEY_FILE: '/keys/secrets.key',
  HOST: '0.0.0.0',
  PORT: '4000',
};
/** Used when the config does not say otherwise. One reverse proxy (Caddy or the ingress) sits in front. */
export const DEFAULT_SETTINGS: Readonly<Record<string, string>> = { XO_API_TRUSTED_PROXY_HOPS: '1' };
/** Generated inside the instance on first boot (`xo instance init-keys`) and never part of a rendered file. */
const GENERATED = new Set(['XO_APPROVAL_SIGNING_KEY', 'XO_SECRETS_KEY']);

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const DIGEST_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const K8S_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function parseDeployConfig(text: string): ConfigResult {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return { ok: false, problems: [`the config file is not valid YAML: ${(e as Error).message.split('\n')[0]}`] };
  }
  const problems: string[] = [];
  if (!isRecord(raw)) return { ok: false, problems: ['the config file must be a YAML mapping'] };
  const known = new Set([
    'format',
    'name',
    'domain',
    'acmeEmail',
    'image',
    'size',
    'dataVolumeGi',
    'settings',
    'secrets',
    'kubernetes',
    'backup',
  ]);
  for (const k of Object.keys(raw)) if (!known.has(k)) problems.push(`${k}: is not a setting of the config file`);
  if (raw['format'] !== 'xo-instance/1') problems.push('format: must be "xo-instance/1"');
  const str = (k: string): string | undefined => (typeof raw[k] === 'string' ? (raw[k] as string).trim() : undefined);

  const name = str('name');
  if (name === undefined || !NAME.test(name))
    problems.push('name: lower-case letters, digits and dashes, starting with a letter, at most 32 characters');
  const domain = str('domain');
  if (domain === undefined || domain === '')
    problems.push('domain: the public DNS name people will use is required (for example xo.your-company.example)');
  else if (!DOMAIN.test(domain)) problems.push('domain: must be a DNS name only, without https:// or a port');
  const acmeEmail = str('acmeEmail');
  if (acmeEmail === undefined || !EMAIL.test(acmeEmail))
    problems.push('acmeEmail: an email address for the certificate account is required');
  const image = str('image');
  if (image === undefined || !DIGEST_IMAGE.test(image))
    problems.push('image: must be pinned by digest, <repository>@sha256:<64 hex digits>');
  const size = str('size');
  if (size !== 'small' && size !== 'medium' && size !== 'large') problems.push('size: small, medium or large');
  const vol = raw['dataVolumeGi'];
  if (typeof vol !== 'number' || !Number.isInteger(vol) || vol < 20) problems.push('dataVolumeGi: a whole number of at least 20');

  const settingsRaw = raw['settings'] ?? {};
  const settings: Record<string, string> = {};
  if (!isRecord(settingsRaw)) problems.push('settings: must be a mapping of XO_* names to text values');
  else
    for (const [k, v] of Object.entries(settingsRaw)) {
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        problems.push(`settings.${k}: must be a text, number or true/false value`);
        continue;
      }
      settings[k] = String(v);
      const spec = settingSpec(k);
      if (k in FIXED_SETTINGS) problems.push(`settings.${k}: is fixed by the template (${k} is set for you)`);
      else if (k === 'XO_PUBLIC_BASE_URL' && domain !== undefined && settings[k] !== `https://${domain}`)
        problems.push(
          `settings.XO_PUBLIC_BASE_URL: derived as https://${domain}; remove it or make it exactly that (an http address is refused)`,
        );
      else if (spec === undefined) problems.push(`settings.${k}: is not an XO setting`);
      else if (spec.secret === true)
        problems.push(`settings.${k}: is a secret; list its name under "secrets" and set its value after boot, never in this file`);
    }

  const secretsRaw = raw['secrets'] ?? [];
  const secrets: { name: string; kubernetesSecret?: string }[] = [];
  if (!Array.isArray(secretsRaw)) problems.push('secrets: must be a list of { name }');
  else
    secretsRaw.forEach((s: unknown, i) => {
      if (!isRecord(s) || typeof s['name'] !== 'string') return void problems.push(`secrets[${i}]: needs a name`);
      const n = s['name'];
      if (settingSpec(n)?.secret !== true) problems.push(`secrets[${i}]: ${n} is not a secret XO setting`);
      else if (GENERATED.has(n)) problems.push(`secrets[${i}]: ${n} is generated inside the instance on first boot; do not list it`);
      const ks = s['kubernetesSecret'];
      if (ks !== undefined && (typeof ks !== 'string' || !K8S_NAME.test(ks)))
        problems.push(`secrets[${i}].kubernetesSecret: must be a Kubernetes name`);
      for (const k of Object.keys(s))
        if (k !== 'name' && k !== 'kubernetesSecret')
          problems.push(`secrets[${i}].${k}: a secret is a name only; its value is never in this file`);
      secrets.push({ name: n, ...(typeof ks === 'string' ? { kubernetesSecret: ks } : {}) });
    });

  let kubernetes: InstanceDeployConfig['kubernetes'];
  if (raw['kubernetes'] !== undefined) {
    const k = raw['kubernetes'];
    if (!isRecord(k) || typeof k['namespace'] !== 'string' || !K8S_NAME.test(k['namespace']))
      problems.push('kubernetes.namespace: a Kubernetes name is required');
    else {
      const opt = (key: string): string | undefined => {
        const v = k[key];
        if (v === undefined) return undefined;
        if (typeof v !== 'string' || !K8S_NAME.test(v)) problems.push(`kubernetes.${key}: must be a Kubernetes name`);
        return typeof v === 'string' ? v : undefined;
      };
      const [storageClass, ingressClass, tlsSecret, certManagerIssuer] = [
        'storageClass',
        'ingressClass',
        'tlsSecret',
        'certManagerIssuer',
      ].map(opt);
      kubernetes = {
        namespace: k['namespace'],
        ...(storageClass !== undefined ? { storageClass } : {}),
        ...(ingressClass !== undefined ? { ingressClass } : {}),
        ...(tlsSecret !== undefined ? { tlsSecret } : {}),
        ...(certManagerIssuer !== undefined ? { certManagerIssuer } : {}),
      };
    }
  }
  let backup: InstanceDeployConfig['backup'];
  if (raw['backup'] !== undefined) {
    const b = raw['backup'];
    if (!isRecord(b) || typeof b['keepDays'] !== 'number' || !Number.isInteger(b['keepDays']) || b['keepDays'] < 1 || b['keepDays'] > 3650)
      problems.push('backup.keepDays: a whole number of days from 1 to 3650');
    else backup = { keepDays: b['keepDays'] };
  }

  // The instance's own start-up validation, in production, with what the template fixes and what the instance generates itself.
  if (problems.length === 0) {
    const env = {
      ...FIXED_SETTINGS,
      ...DEFAULT_SETTINGS,
      XO_PUBLIC_BASE_URL: `https://${domain}`,
      ...settings,
      XO_APPROVAL_SIGNING_KEY: 'generated-on-first-boot',
    };
    const resolved = resolveSettings(env, { joinPath: (...p) => p.join('/') });
    for (const e of resolved.errors) problems.push(`settings: ${e.name} ${e.message}`);
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      format: 'xo-instance/1',
      name: name!,
      domain: domain!.toLowerCase(),
      acmeEmail: acmeEmail!,
      image: image!,
      size: size as DeploySize,
      dataVolumeGi: vol as number,
      settings,
      secrets,
      ...(kubernetes !== undefined ? { kubernetes } : {}),
      ...(backup !== undefined ? { backup } : {}),
    },
  };
}

/** The environment a rendered instance runs with (never a secret): what the template fixes, the defaults, then the config's settings. */
export function instanceEnvironment(config: InstanceDeployConfig): Record<string, string> {
  return { ...FIXED_SETTINGS, ...DEFAULT_SETTINGS, XO_PUBLIC_BASE_URL: `https://${config.domain}`, ...config.settings };
}

/** What must still be provided after rendering, in plain words (`xo deploy check`). */
export function stillNeeded(config: InstanceDeployConfig, target: 'vm' | 'kubernetes'): string[] {
  const out = [
    `a DNS record: ${config.domain} → the ${target === 'vm' ? 'machine’s public address' : 'ingress or load balancer address'}`,
    `the trust policy file named by XO_PACKAGE_TRUST_POLICY (${target === 'vm' ? '/srv/xo/trust/policy.json on the machine' : `the ConfigMap ${config.name}-trust`})`,
    `the sign-in redirect addresses registered with your identity providers: https://${config.domain}/auth/callback and https://${config.domain}/oauth/callback`,
  ];
  for (const s of config.secrets)
    out.push(
      target === 'vm'
        ? `secret ${s.name}: xo secrets set ${s.name} (after the first boot)`
        : `secret ${s.name}: key ${s.name} in the Secret ${s.kubernetesSecret ?? `${config.name}-secrets`}`,
    );
  return out;
}
