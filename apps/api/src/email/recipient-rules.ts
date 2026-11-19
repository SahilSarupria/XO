/**
 * UW-10c (ADR 0042) — a workspace's explicit recipient rules: addresses and domains the manage role allows XO to write to, in
 * addition to the people in confirmed contact lists. Default deny: an empty rule set allows nothing by itself.
 */
import { join } from 'node:path';
import { ErrorCode, XoError } from '@xo/errors';
import { LocalFsBlobStore } from '@xo/storage';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import type { WorkspaceDataConfig } from '../workspace/workspace-context.js';

const KEY = 'email-recipient-rules.json';
const ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;
const DOMAIN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const MAX_RULES = 500;

export interface RecipientRules {
  readonly revision: number;
  readonly addresses: readonly string[];
  readonly domains: readonly string[];
  readonly updatedAt?: string;
  readonly updatedBy?: string;
}

const store = (w: WorkspaceRecord, c: WorkspaceDataConfig): LocalFsBlobStore =>
  new LocalFsBlobStore(join(c.dataRootDir, w.workspaceId, 'email'));

export async function readRecipientRules(w: WorkspaceRecord, c: WorkspaceDataConfig): Promise<RecipientRules> {
  const raw = await store(w, c).get(KEY);
  if (!raw.ok) return { revision: 0, addresses: [], domains: [] };
  return JSON.parse(new TextDecoder().decode(raw.value)) as RecipientRules;
}

export async function writeRecipientRules(w: WorkspaceRecord, c: WorkspaceDataConfig, value: RecipientRules): Promise<void> {
  const r = await store(w, c).replace(KEY, JSON.stringify(value), { contentType: 'application/json' });
  if (!r.ok) throw r.error;
}

/** Strict: only `addresses` and `domains`, each a bounded list of well-formed, lower-cased, de-duplicated entries. */
export function parseRecipientRules(v: unknown): { addresses: string[]; domains: string[] } {
  const bad = (m: string): never => {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, m);
  };
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return bad('rules must be an object');
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !['addresses', 'domains', 'expectedRevision'].includes(k));
  if (extra.length > 0) bad(`unknown field(s): ${extra.join(', ')}`);
  const list = (name: string, re: RegExp): string[] => {
    const x = o[name] ?? [];
    if (!Array.isArray(x) || x.length > MAX_RULES || !x.every((s) => typeof s === 'string' && re.test(s)))
      return bad(`${name} must be a list of at most ${MAX_RULES} valid entries`);
    return [...new Set((x as string[]).map((s) => s.toLowerCase()))].sort();
  };
  return { addresses: list('addresses', ADDRESS), domains: list('domains', DOMAIN) };
}
