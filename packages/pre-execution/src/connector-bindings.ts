/**
 * ADR 0030 — connector bindings: the operator's statement of how each declared operation is carried out (connector,
 * operation, side effect, undo, host adapter). One parser for the API and the CLI, so a bindings file means the same in both.
 */
import type { ConnectorBinding } from './lower-workflow.js';

const KINDS = ['http', 'webhook_out', 'file', 'smtp', 'slack_webhook', 'database', 'mcp'] as const;
const EFFECTS = ['read', 'write', 'irreversible'] as const;
const CONNECTOR_ID = /^[a-z][a-z0-9_]{0,63}$/;
const OPERATION = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
export const MAX_CONNECTOR_BINDINGS = 500;

/** Thrown for a bindings document that does not validate; the message names the offending entry. */
export class ConnectorBindingsError extends Error {
  override readonly name = 'ConnectorBindingsError';
}

const bad = (m: string): never => {
  throw new ConnectorBindingsError(m);
};

/** Validates a request body field by field; no extra fields are carried into the stored bindings. */
export function parseConnectorBindings(v: unknown): ConnectorBinding[] {
  if (!Array.isArray(v)) return bad('bindings must be an array');
  if (v.length > MAX_CONNECTOR_BINDINGS) bad(`at most ${MAX_CONNECTOR_BINDINGS} bindings`);
  const seen = new Set<string>();
  return v.map((x, i) => {
    if (typeof x !== 'object' || x === null) return bad(`bindings[${i}] must be an object`);
    const o = x as Record<string, unknown>;
    const extra = Object.keys(o).filter(
      (k) => !['capability', 'connector', 'kind', 'operation', 'sideEffect', 'compensation', 'adapter'].includes(k),
    );
    if (extra.length > 0) bad(`bindings[${i}] has unknown field(s): ${extra.join(', ')}`);
    const str = (k: string, re?: RegExp, max = 200): string => {
      const s = o[k];
      if (typeof s !== 'string' || s.trim() === '' || s.length > max || (re !== undefined && !re.test(s)))
        return bad(`bindings[${i}].${k} is invalid`);
      return s;
    };
    const capability = str('capability');
    if (seen.has(capability)) bad(`capability "${capability}" is bound twice`);
    seen.add(capability);
    const kind = str('kind');
    if (!(KINDS as readonly string[]).includes(kind)) bad(`bindings[${i}].kind must be one of ${KINDS.join(', ')}`);
    const sideEffect = str('sideEffect');
    if (!(EFFECTS as readonly string[]).includes(sideEffect)) bad(`bindings[${i}].sideEffect must be read, write or irreversible`);
    if (kind === 'database' && sideEffect !== 'read') bad(`bindings[${i}]: database connectors are read-only`);
    let compensation: ConnectorBinding['compensation'];
    if (o['compensation'] !== undefined) {
      const c = o['compensation'] as Record<string, unknown>;
      if (
        typeof c !== 'object' ||
        c === null ||
        typeof c['operation'] !== 'string' ||
        !OPERATION.test(c['operation']) ||
        !(EFFECTS as readonly string[]).includes(c['sideEffect'] as string)
      )
        bad(`bindings[${i}].compensation must be { operation, sideEffect }`);
      if (sideEffect === 'read') bad(`bindings[${i}]: a read has nothing to undo`);
      compensation = { operation: c['operation'] as string, sideEffect: c['sideEffect'] as ConnectorBinding['sideEffect'] };
    }
    return {
      capability,
      connector: str('connector', CONNECTOR_ID, 64),
      kind: kind as ConnectorBinding['kind'],
      operation: str('operation', OPERATION, 64),
      sideEffect: sideEffect as ConnectorBinding['sideEffect'],
      ...(compensation !== undefined ? { compensation } : {}),
      adapter: str('adapter', /^[A-Za-z0-9_.:-]{1,128}$/, 128),
    };
  });
}
