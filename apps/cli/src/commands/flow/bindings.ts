import {
  databaseConnector,
  fileConnector,
  httpConnector,
  slackWebhookConnector,
  smtpConnector,
  sqliteReadOnlyDriver,
  webhookOutConnector,
  type Connector,
  type ConnectorPolicy,
} from '@xo/connectors';
import type { WorkflowComponent } from '@xo/workflow-ir';
import { err, ok, type Result } from '@xo/types';

/**
 * The operator's side of every connector: WHERE it points and WHAT it may do. A package declares connectors by id and kind only; this file (never shipped,
 * never in a package) binds each id to a destination, a directory, a database. A declared connector with no binding simply has no implementation, so
 * a call to it fails closed.
 *
 * The operator policy file (`--policy`) carries, next to the existing `connectors` grants:
 *   "bindings": { "<connector id>": { ...settings for that connector's KIND... } }
 *   "fileRoots": { "<id>": { "<root>": "/dir" } }      (older spelling, still accepted for file connectors)
 * Unknown keys, bindings for connectors the package does not declare, and malformed values are errors: a typo must not widen or silently drop access.
 */
export interface OperatorPolicyFile extends ConnectorPolicy {
  readonly fileRoots?: Record<string, Record<string, string>>;
  readonly bindings?: Record<string, Record<string, unknown>>;
}

const KEYS: Record<string, readonly string[]> = {
  file: ['roots', 'maxBytes', 'createRoots'],
  http: ['baseUrl', 'methods', 'pathPatterns', 'maxResponseBytes', 'maxRequestBytes', 'bearerSecret', 'allowPrivateNetwork'],
  webhook_out: ['url', 'allowedHosts', 'allowedPorts', 'signingSecret', 'maxRequestBytes', 'maxResponseBytes', 'allowPrivateNetwork'],
  slack_webhook: ['webhookSecret', 'allowedHosts', 'allowedPorts', 'maxTextChars', 'allowPrivateNetwork'],
  smtp: ['host', 'port', 'security', 'from', 'allowedRecipientDomains', 'maxRecipients', 'maxBodyBytes', 'userSecret', 'passwordSecret'],
  database: ['driver', 'statements', 'maxRows', 'maxResultBytes', 'onOverflow'],
};

export async function buildImplementations(
  comp: WorkflowComponent,
  policy: OperatorPolicyFile,
): Promise<Result<Record<string, Connector>, string>> {
  const declared = new Map(comp.connectors.map((c) => [c.id, c.kind]));
  const merged: Record<string, Record<string, unknown>> = { ...(policy.bindings ?? {}) };
  for (const [id, roots] of Object.entries(policy.fileRoots ?? {})) {
    if (merged[id] !== undefined) return err(`connector "${id}" is bound in both "fileRoots" and "bindings"; use one`);
    merged[id] = { roots };
  }
  const problems: string[] = [];
  for (const id of Object.keys(merged))
    if (!declared.has(id)) problems.push(`binding for "${id}", which no workflow in this package declares`);
  if (problems.length > 0) return err(problems.join('; '));

  const out: Record<string, Connector> = {};
  for (const [id, kind] of declared) {
    const b = merged[id];
    if (b === undefined) continue;
    const allowed = KEYS[kind];
    if (allowed === undefined) {
      problems.push(`connector "${id}" is of kind "${kind}", which the CLI cannot bind yet`);
      continue;
    }
    const stray = Object.keys(b).filter((k) => !allowed.includes(k));
    if (stray.length > 0) {
      problems.push(`binding "${id}" (${kind}): unknown key(s) ${stray.join(', ')}; allowed: ${allowed.join(', ')}`);
      continue;
    }
    try {
      out[id] = await build(kind, b);
    } catch (e) {
      problems.push(`binding "${id}" (${kind}): ${(e as Error).message}`);
    }
  }
  return problems.length > 0 ? err(problems.join('; ')) : ok(out);
}

async function build(kind: string, b: Record<string, unknown>): Promise<Connector> {
  switch (kind) {
    case 'file': {
      const roots = b['roots'] as Record<string, string> | undefined;
      if (typeof roots !== 'object' || roots === null || Object.values(roots).some((v) => typeof v !== 'string'))
        throw new Error('"roots" must map root ids to directory paths');
      // the directory path is the operator's own, so creating it on first write is the operator's choice; `createRoots: false` keeps the strict behaviour
      return fileConnector({ roots, maxBytes: Number(b['maxBytes'] ?? 1_048_576), createRoots: b['createRoots'] !== false });
    }
    case 'http':
      return httpConnector(b as never);
    case 'webhook_out':
      return webhookOutConnector(b as never);
    case 'slack_webhook':
      return slackWebhookConnector(b as never);
    case 'smtp':
      return smtpConnector(b as never);
    case 'database': {
      const d = b['driver'] as { type?: unknown; path?: unknown } | undefined;
      if (d?.type !== 'sqlite' || typeof d.path !== 'string')
        throw new Error('"driver" must be {"type":"sqlite","path":"<file>"} (other drivers are supplied by embedding applications)');
      return databaseConnector({ ...(b as Record<string, unknown>), driver: await sqliteReadOnlyDriver(d.path) } as never);
    }
    default:
      throw new Error(`no builder for kind ${kind}`);
  }
}
