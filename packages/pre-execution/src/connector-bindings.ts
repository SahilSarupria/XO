/**
 * ADR 0030 — connector bindings: the operator's statement of how each declared operation is carried out (connector,
 * operation, side effect, undo, host adapter). One parser for the API and the CLI, so a bindings file means the same in both.
 */
import type { BindingArgument, ConnectorBinding } from './lower-workflow.js';

const KINDS = ['http', 'webhook_out', 'file', 'smtp', 'slack_webhook', 'database', 'mcp'] as const;
const EFFECTS = ['read', 'write', 'irreversible'] as const;
const CONNECTOR_ID = /^[a-z][a-z0-9_]{0,63}$/;
const OPERATION = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
export const MAX_CONNECTOR_BINDINGS = 500;
/** V1-1 (ADR 0049): at most this many arguments per binding; a constant at most this long. */
export const MAX_BINDING_ARGUMENTS = 32;
export const MAX_ARGUMENT_CONST = 4000;
const ARGUMENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;

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
      (k) =>
        !['capability', 'connector', 'kind', 'operation', 'sideEffect', 'compensation', 'adapter', 'credentialId', 'arguments'].includes(k),
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
    // V1-1 (ADR 0049): the arguments of the call, each from a field of the item (or input) or a constant the operator wrote. A binding
    // with arguments is the operator's statement that XO carries the step out, whatever the source says (a person's task included).
    let args: Record<string, BindingArgument> | undefined;
    if (o['arguments'] !== undefined) {
      const a = o['arguments'];
      if (typeof a !== 'object' || a === null || Array.isArray(a)) return bad(`bindings[${i}].arguments must be an object`);
      const entries = Object.entries(a as Record<string, unknown>);
      if (entries.length === 0 || entries.length > MAX_BINDING_ARGUMENTS)
        bad(`bindings[${i}].arguments must name 1 to ${MAX_BINDING_ARGUMENTS} arguments`);
      args = {};
      for (const [name, v] of entries) {
        if (!ARGUMENT_NAME.test(name) || name === 'previous_decision' || name === 'route')
          bad(`bindings[${i}].arguments: "${name}" is not a valid argument name`);
        const src = v as Record<string, unknown> | null;
        const keys = src !== null && typeof src === 'object' ? Object.keys(src) : [];
        if (keys.length === 1 && keys[0] === 'field' && typeof src!['field'] === 'string' && FIELD_NAME.test(src!['field']))
          args[name] = { field: src!['field'] };
        else if (
          keys.length === 1 &&
          keys[0] === 'const' &&
          ((typeof src!['const'] === 'string' && src!['const'].length <= MAX_ARGUMENT_CONST) ||
            typeof src!['const'] === 'boolean' ||
            (typeof src!['const'] === 'number' && Number.isFinite(src!['const'])))
        )
          args[name] = { const: src!['const'] as string | number | boolean };
        else
          bad(
            `bindings[${i}].arguments.${name} must be { "field": "<lower_snake_case field>" } or { "const": <text of at most ${MAX_ARGUMENT_CONST} characters, a number or true/false> }`,
          );
      }
    }
    return {
      capability,
      connector: str('connector', CONNECTOR_ID, 64),
      kind: kind as ConnectorBinding['kind'],
      operation: str('operation', OPERATION, 64),
      sideEffect: sideEffect as ConnectorBinding['sideEffect'],
      ...(compensation !== undefined ? { compensation } : {}),
      adapter: str('adapter', /^[A-Za-z0-9_.:-]{1,128}$/, 128),
      ...(o['credentialId'] !== undefined ? { credentialId: str('credentialId', /^crd_[0-9a-f]{24}$/, 28) } : {}),
      ...(args !== undefined ? { arguments: args } : {}),
    };
  });
}
