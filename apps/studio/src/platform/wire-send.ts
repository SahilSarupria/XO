/**
 * S1-5 — the send set-up of a workflow: the workspace's email accounts (`GET …/credentials`, capability `message.send`) and its
 * connector bindings (`GET`/`PUT …/connector-bindings`, ADR 0049). Everything is checked; a field that breaks the contract makes the
 * whole answer a problem. A binding is kept as the platform sent it, so saving one step never changes another.
 */
import { WireParseError, arr, num, obj, optStr, str, strArr } from './wire';

export type EmailProvider = 'google' | 'microsoft' | 'smtp';

export interface EmailAccount {
  readonly credentialId: string;
  readonly provider: EmailProvider;
  readonly state: string;
  readonly accountLabel?: string;
}

export function parseEmailAccounts(v: unknown): EmailAccount[] {
  return arr(obj(v, 'body')['credentials'], 'credentials').flatMap((x, i) => {
    const c = obj(x, `credentials[${i}]`);
    const provider = c['provider'];
    if (provider !== 'google' && provider !== 'microsoft' && provider !== 'smtp') return [];
    if (!strArr(c['capabilities'], `credentials[${i}].capabilities`).includes('message.send')) return [];
    const label = optStr(c['accountLabel'], `credentials[${i}].accountLabel`);
    return [
      {
        credentialId: str(c['credentialId'], `credentials[${i}].credentialId`),
        provider,
        state: str(c['state'], `credentials[${i}].state`),
        ...(label !== undefined ? { accountLabel: label } : {}),
      },
    ];
  });
}

export type BindingArgument = { readonly field: string } | { readonly const: string | number | boolean };

export interface ConnectorBindingView {
  readonly capability: string;
  readonly connector: string;
  readonly kind: string;
  readonly operation: string;
  readonly sideEffect: string;
  readonly adapter: string;
  readonly credentialId?: string;
  readonly arguments?: Readonly<Record<string, BindingArgument>>;
  /** Anything else the platform sent (a compensation, say): sent back unchanged. */
  readonly rest: Readonly<Record<string, unknown>>;
}

export interface BindingsView {
  readonly revision: number;
  readonly bindings: readonly ConnectorBindingView[];
}

const KNOWN = new Set(['capability', 'connector', 'kind', 'operation', 'sideEffect', 'adapter', 'credentialId', 'arguments']);
// Fields the platform adds when it reads bindings; they are not part of what is saved.
const READ_ONLY = new Set(['adapterInstalled', 'emailTier']);

export function parseBindings(v: unknown): BindingsView {
  const o = obj(v, 'connector-bindings');
  return {
    revision: num(o['revision'], 'revision'),
    bindings: arr(o['bindings'], 'bindings').map((b, i) => {
      const p = `bindings[${i}]`;
      const y = obj(b, p);
      const credentialId = optStr(y['credentialId'], `${p}.credentialId`);
      let args: Record<string, BindingArgument> | undefined;
      if (y['arguments'] !== undefined) {
        const a = obj(y['arguments'], `${p}.arguments`);
        args = {};
        for (const [k, raw] of Object.entries(a)) {
          const e = obj(raw, `${p}.arguments.${k}`);
          if (typeof e['field'] === 'string') args[k] = { field: e['field'] };
          else if ('const' in e && ['string', 'number', 'boolean'].includes(typeof e['const']))
            args[k] = { const: e['const'] as string | number | boolean };
          else throw new WireParseError(`${p}.arguments.${k}`, 'a field or a constant');
        }
      }
      const rest: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(y)) if (!KNOWN.has(k) && !READ_ONLY.has(k)) rest[k] = val;
      return {
        capability: str(y['capability'], `${p}.capability`),
        connector: str(y['connector'], `${p}.connector`),
        kind: str(y['kind'], `${p}.kind`),
        operation: str(y['operation'], `${p}.operation`),
        sideEffect: str(y['sideEffect'], `${p}.sideEffect`),
        adapter: str(y['adapter'], `${p}.adapter`),
        ...(credentialId !== undefined ? { credentialId } : {}),
        ...(args !== undefined ? { arguments: args } : {}),
        rest,
      };
    }),
  };
}

/** The request body of one binding: what the platform validates, nothing else. */
export function bindingBody(b: ConnectorBindingView): Record<string, unknown> {
  return {
    ...b.rest,
    capability: b.capability,
    connector: b.connector,
    kind: b.kind,
    operation: b.operation,
    sideEffect: b.sideEffect,
    adapter: b.adapter,
    ...(b.credentialId !== undefined ? { credentialId: b.credentialId } : {}),
    ...(b.arguments !== undefined ? { arguments: b.arguments } : {}),
  };
}
