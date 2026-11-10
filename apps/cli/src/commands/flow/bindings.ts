import {
  databaseConnector,
  fileConnector,
  EnvVault,
  confinementRecord,
  httpConnector,
  mcpConnector,
  planConfinement,
  type McpConfig,
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
  mcp: ['command', 'args', 'env', 'cwd', 'url', 'bearerSecret', 'allowPrivateNetwork', 'tools', 'maxResponseBytes', 'confine'],
  database: ['driver', 'statements', 'maxRows', 'maxResultBytes', 'onOverflow'],
};

export interface BuildDeps {
  /** Reads `secret:NAME` references. Default: `XO_SECRET_*` environment variables. */
  readonly secret?: (name: string) => string | undefined;
  /** Receives the confinement record of every MCP stdio server, so the caller can journal it and warn about opt-outs. */
  readonly onConfinement?: (connectorId: string, record: Record<string, unknown>) => void;
}

export async function buildImplementations(
  comp: WorkflowComponent,
  policy: OperatorPolicyFile,
  deps: BuildDeps = {},
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
      out[id] = await build(kind, b, id, deps);
    } catch (e) {
      problems.push(`binding "${id}" (${kind}): ${(e as Error).message}`);
    }
  }
  return problems.length > 0 ? err(problems.join('; ')) : ok(out);
}

async function build(kind: string, b: Record<string, unknown>, id: string, deps: BuildDeps): Promise<Connector> {
  switch (kind) {
    case 'mcp':
      return buildMcp(b, id, deps);
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

const CONFINE_KEYS = ['require', 'allowUnconfined', 'disable', 'network', 'readOnlyPaths', 'writablePaths', 'operatorWrapper'];

/**
 * An MCP server binding. A stdio server is launched ONLY inside a confinement plan: with no `confine` block the default applies (confined, no network,
 * refuse if the host cannot). Running without confinement needs `"confine": {"allowUnconfined": true}` or `{"disable": true}`; either is recorded.
 */
function buildMcp(b: Record<string, unknown>, id: string, deps: BuildDeps): Connector {
  const confine = (b['confine'] ?? {}) as Record<string, unknown>;
  if (typeof confine !== 'object' || confine === null || Array.isArray(confine)) throw new Error('"confine" must be an object');
  const stray = Object.keys(confine).filter((k) => !CONFINE_KEYS.includes(k));
  if (stray.length > 0) throw new Error(`unknown "confine" key(s) ${stray.join(', ')}; allowed: ${CONFINE_KEYS.join(', ')}`);
  for (const k of ['allowUnconfined', 'disable'])
    if (confine[k] !== undefined && typeof confine[k] !== 'boolean') throw new Error(`"confine.${k}" must be true or false`);
  const strList = (k: string): string[] | undefined => {
    const v = confine[k];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`"confine.${k}" must be a list of strings`);
    return v as string[];
  };
  if (b['tools'] === undefined || typeof b['tools'] !== 'object' || b['tools'] === null)
    throw new Error('"tools" must map operation names to {tool, sideEffect}');
  const tools: Record<string, { tool: string; sideEffect: 'read' | 'write' | 'irreversible' }> = {};
  for (const [op, t] of Object.entries(b['tools'] as Record<string, unknown>)) {
    const tt = t as { tool?: unknown; sideEffect?: unknown };
    if (typeof tt?.tool !== 'string') throw new Error(`tool "${op}" needs a "tool" name`);
    if (!['read', 'write', 'irreversible'].includes(String(tt.sideEffect ?? 'write')))
      throw new Error(`tool "${op}": sideEffect must be read, write or irreversible`);
    tools[op] = { tool: tt.tool, sideEffect: (tt.sideEffect ?? 'write') as 'read' | 'write' | 'irreversible' }; // an omitted side effect is the safe assumption: write
  }
  const maxResponseBytes = Number(b['maxResponseBytes'] ?? 65_536);
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error('"maxResponseBytes" must be a positive integer');
  let server: McpConfig['server'];
  if (typeof b['command'] === 'string') {
    if (b['url'] !== undefined) throw new Error('give "command" (stdio) or "url" (http), not both');
    const plan = planConfinement({
      ...(confine['require'] !== undefined ? { require: confine['require'] as 'filesystem' | 'namespaces' } : {}),
      ...(confine['allowUnconfined'] === true ? { allowUnconfined: true } : {}),
      ...(confine['disable'] === true ? { disable: true } : {}),
      ...(confine['network'] !== undefined ? { network: confine['network'] as 'none' | 'host' } : {}),
      ...(strList('readOnlyPaths') !== undefined ? { readOnlyPaths: strList('readOnlyPaths') as string[] } : {}),
      ...(strList('writablePaths') !== undefined ? { writablePaths: strList('writablePaths') as string[] } : {}),
      ...(strList('operatorWrapper') !== undefined ? { operatorWrapper: strList('operatorWrapper') as string[] } : {}),
    });
    deps.onConfinement?.(id, confinementRecord(plan));
    server = {
      transport: 'stdio',
      command: b['command'],
      ...(b['args'] !== undefined ? { args: b['args'] as string[] } : {}),
      ...(b['env'] !== undefined ? { env: b['env'] as Record<string, string> } : {}),
      ...(typeof b['cwd'] === 'string' ? { cwd: b['cwd'] } : {}),
      confinement: plan,
    };
  } else if (typeof b['url'] === 'string') {
    if (b['confine'] !== undefined) throw new Error('"confine" applies to stdio servers only');
    server = {
      transport: 'http',
      url: b['url'],
      ...(typeof b['bearerSecret'] === 'string' ? { bearerSecret: b['bearerSecret'] } : {}),
      ...(b['allowPrivateNetwork'] === true ? { allowPrivateNetwork: true } : {}),
    };
  } else throw new Error('give "command" (stdio) or "url" (http)');
  const vault = new EnvVault();
  return mcpConnector({ server, tools, maxResponseBytes }, { secret: deps.secret ?? ((n) => vault.get(n)) });
}
