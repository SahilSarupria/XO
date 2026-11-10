import { validateCapabilityInput } from '@xo/capability-contract';
import type { CapabilityInputSchema } from '@xo/types';
import type { ApiResult, XoApi } from './api-client.js';

/**
 * P1.1 M5 — tool mapping. A tool is NOT a capability grant: it is a name for one approved procedure VERSION, derived from the
 * API's own answer. The name is a lookup key only; every call re-reads the version from the API, re-validates the arguments
 * against the schema the API derived, and the API's start route re-checks lifecycle, per-step authorization, approvals and the
 * M4 external-effect gates. Nothing here decides who may run what.
 */

/** Kept in step with the API runner's constant (apps/api/src/procedures/procedure-runner.ts); the end-to-end test asserts the equality. */
export const EFFECT_OUTCOME_UNKNOWN_CODE = 'XO_EXTERNAL_EFFECT_OUTCOME_UNKNOWN';
export const EFFECT_PAYLOAD_APPROVAL_REQUIRED_CODE = 'XO_EXTERNAL_EFFECT_PAYLOAD_APPROVAL_REQUIRED';
export const EFFECT_FRESH_APPROVAL_REQUIRED_CODE = 'XO_EXTERNAL_EFFECT_FRESH_APPROVAL_REQUIRED';

/** Hard bound on advertised tools (each needs one audited API read). Truncation is reported on stderr, never silent. */
export const MAX_TOOLS = 100;
const TOOL_NAME = /^([A-Za-z][A-Za-z0-9_-]*)\.v([1-9][0-9]*)$/;
const MAX_NAME = 128;

export interface ToolRef {
  readonly procedureId: string;
  readonly version: number;
}

export const toolNameOf = (ref: ToolRef): string => `${ref.procedureId}.v${ref.version}`;

export function parseToolName(name: string): ToolRef | undefined {
  if (name.length > MAX_NAME) return undefined;
  const m = TOOL_NAME.exec(name);
  if (m === null) return undefined;
  const procedureId = m[1] as string;
  if (procedureId === '__proto__' || procedureId === 'constructor' || procedureId === 'prototype') return undefined;
  const version = Number(m[2]);
  return Number.isSafeInteger(version) ? { procedureId, version } : undefined;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { readonly type: 'string' | 'number' | 'boolean' }>>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Strict re-check of the schema the API reported; anything unexpected means "not callable" (fail closed). */
export function readInputSchema(raw: unknown): CapabilityInputSchema | undefined {
  if (!isRecord(raw) || raw['type'] !== 'object' || raw['additionalProperties'] !== false) return undefined;
  const props = raw['properties'];
  const required = raw['required'];
  if (!isRecord(props) || !Array.isArray(required)) return undefined;
  const out: Record<string, { type: 'string' | 'number' | 'boolean' }> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!isRecord(v)) return undefined;
    const t = v['type'];
    if (t !== 'string' && t !== 'number' && t !== 'boolean') return undefined;
    out[k] = { type: t };
  }
  const req: string[] = [];
  for (const r of required) {
    if (typeof r !== 'string' || !has(out, r)) return undefined;
    req.push(r);
  }
  return { type: 'object', properties: out, required: req };
}

export interface ProcedureDetail {
  readonly ref: ToolRef;
  readonly title: string | undefined;
  readonly schema: CapabilityInputSchema;
}

/** `undefined` unless the API reports this exact version as APPROVED and gives a usable schema. */
export function readDetail(ref: ToolRef, body: unknown): ProcedureDetail | undefined {
  if (!isRecord(body)) return undefined;
  if (body['procedureId'] !== ref.procedureId || body['version'] !== ref.version || body['lifecycle'] !== 'approved') return undefined;
  const schema = readInputSchema(body['inputSchema']);
  if (schema === undefined) return undefined;
  const def = body['definition'];
  const title = isRecord(def) && typeof def['title'] === 'string' ? def['title'].slice(0, 120) : undefined;
  return { ref, title, schema };
}

export function describeTool(d: ProcedureDetail): McpToolDescriptor {
  const label = d.title === undefined ? '' : ` — ${d.title}`;
  return {
    name: toolNameOf(d.ref),
    ...(d.title !== undefined ? { title: d.title } : {}),
    description:
      `Start the approved XO procedure "${d.ref.procedureId}" version ${d.ref.version}${label}. ` +
      `Listing this tool grants no authority: the XO API re-checks approval, permissions and input on every call, and a human may still need to approve a step in XO.`,
    inputSchema: {
      type: 'object',
      properties: d.schema.properties,
      required: d.schema.required,
      additionalProperties: false,
    },
  };
}

export type DiscoveryResult =
  | { readonly kind: 'ok'; readonly tools: readonly McpToolDescriptor[]; readonly truncated: boolean }
  | { readonly kind: 'failed'; readonly api: Exclude<ApiResult, { kind: 'ok' }> };

/** Discovery only READS (list + per-version get). It never starts anything. */
export async function discoverTools(api: XoApi, signal: AbortSignal): Promise<DiscoveryResult> {
  const listed = await api.listProcedures(signal);
  if (listed.kind !== 'ok') return { kind: 'failed', api: listed };
  const refs: ToolRef[] = [];
  const procedures = isRecord(listed.body) && Array.isArray(listed.body['procedures']) ? listed.body['procedures'] : [];
  for (const p of procedures) {
    if (!isRecord(p) || typeof p['procedureId'] !== 'string' || !Array.isArray(p['versions'])) continue;
    for (const v of p['versions']) {
      if (!isRecord(v) || v['lifecycle'] !== 'approved' || typeof v['version'] !== 'number') continue;
      const ref = parseToolName(`${p['procedureId']}.v${v['version']}`);
      if (ref !== undefined && ref.procedureId === p['procedureId'] && ref.version === v['version']) refs.push(ref);
    }
  }
  const tools: McpToolDescriptor[] = [];
  let truncated = false;
  for (const ref of refs) {
    if (tools.length >= MAX_TOOLS) {
      truncated = true;
      break;
    }
    const got = await api.getProcedure(ref.procedureId, ref.version, signal);
    if (got.kind !== 'ok') {
      // A version that cannot be read right now is simply not advertised; a transport failure aborts discovery honestly.
      if (got.kind === 'no_answer') return { kind: 'failed', api: got };
      continue;
    }
    const detail = readDetail(ref, got.body);
    if (detail !== undefined) tools.push(describeTool(detail));
  }
  return { kind: 'ok', tools, truncated };
}

export interface ArgumentProblem {
  readonly property: string;
  readonly message: string;
}

/** Closed validation against the API-derived schema. Never echoes a submitted value or an unrecognized property name. */
export function validateArguments(schema: CapabilityInputSchema, args: unknown): readonly ArgumentProblem[] {
  const result = validateCapabilityInput(schema, args);
  if (result.valid) return [];
  return result.issues.map((i) => ({
    property: i.property === '$' || has(schema.properties, i.property) ? i.property : '(unrecognized property)',
    message: has(schema.properties, i.property) || i.property === '$' ? i.message : "not declared in this tool's input schema",
  }));
}
