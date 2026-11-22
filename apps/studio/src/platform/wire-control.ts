/**
 * UW-12b (ADR 0047) — the control surface as Studio reads it: the workspace's runtime inbox, a batch preview and its approval.
 * Parsed strictly. Studio only shows what the platform says and sends a person's decision back; the platform decides everything
 * again (role, recent sign-in, separation of duties, the root the person saw).
 */
import { WireParseError, arr, bool, num, obj, optStr, str, strArr } from './wire';

export const PREVIEW_ITEM_STATES = ['sends', 'no_effect', 'stops', 'not_exact'] as const;
export type PreviewItemState = (typeof PREVIEW_ITEM_STATES)[number];
export type PreviewCounts = Readonly<Record<PreviewItemState, number>>;

export interface BatchApprovalView {
  readonly approvalId: string;
  readonly reviewerId: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly usedBy?: string;
}

export interface InboxBatch {
  readonly definitionId: string;
  readonly workflowName: string;
  readonly state: 'awaiting_approval' | 'ready_to_start';
  readonly previewId: string;
  readonly certificateId: string;
  readonly root: string;
  readonly total: number;
  readonly counts: PreviewCounts;
  readonly senders: readonly { readonly connector: string; readonly account?: string }[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly preparedByYou: boolean;
  readonly approval?: BatchApprovalView;
}

export interface InboxStep {
  readonly definitionId: string;
  readonly workflowName: string;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly item?: number;
  readonly approvalId: string;
  readonly step: string;
  readonly summary: string;
  readonly proposedActions: readonly string[];
  readonly requestedAt: string;
  readonly expiresAt: string;
}

export interface InboxAttention {
  readonly definitionId: string;
  readonly workflowName: string;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly item?: number;
  readonly step: string;
  readonly connector: string;
  readonly operation: string;
  readonly state: string;
  readonly intentAt: string;
  readonly detail: string;
}

export interface ControlInbox {
  readonly batches: readonly InboxBatch[];
  readonly steps: readonly InboxStep[];
  readonly attention: readonly InboxAttention[];
  readonly truncated: boolean;
}

export interface PreviewActionView {
  readonly step: string;
  readonly connector: string;
  readonly operation: string;
  readonly sideEffect: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface PreviewItemView {
  readonly index: number;
  readonly state: PreviewItemState;
  readonly reason?: string;
  readonly approvals: readonly string[];
  readonly actions: readonly PreviewActionView[];
}

export interface BatchPreviewView {
  readonly previewId: string;
  readonly definitionId: string;
  readonly certificateId: string;
  readonly root: string;
  readonly forEach: boolean;
  readonly effects: boolean;
  readonly counts: PreviewCounts;
  readonly senders: readonly { readonly connector: string; readonly provider?: string; readonly account?: string }[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly approvable: boolean;
  readonly approval?: BatchApprovalView;
  readonly page: number;
  readonly pages: number;
  readonly total: number;
  readonly items: readonly PreviewItemView[];
}

function counts(v: unknown, path: string): PreviewCounts {
  const o = obj(v, path);
  return {
    sends: num(o['sends'], `${path}.sends`),
    no_effect: num(o['no_effect'], `${path}.no_effect`),
    stops: num(o['stops'], `${path}.stops`),
    not_exact: num(o['not_exact'], `${path}.not_exact`),
  };
}

function approval(v: unknown, path: string): BatchApprovalView | undefined {
  if (v === undefined) return undefined;
  const o = obj(v, path);
  const usedBy = optStr(o['usedBy'], `${path}.usedBy`);
  return {
    approvalId: str(o['approvalId'], `${path}.approvalId`),
    reviewerId: str(o['reviewerId'], `${path}.reviewerId`),
    approvedAt: str(o['approvedAt'], `${path}.approvedAt`),
    expiresAt: str(o['expiresAt'], `${path}.expiresAt`),
    ...(usedBy !== undefined ? { usedBy } : {}),
  };
}

function itemRef(o: Record<string, unknown>, path: string): { parentRunId?: string; item?: number } {
  const parentRunId = optStr(o['parentRunId'], `${path}.parentRunId`);
  const item = o['item'] === undefined ? undefined : num(o['item'], `${path}.item`);
  return { ...(parentRunId !== undefined ? { parentRunId } : {}), ...(item !== undefined ? { item } : {}) };
}

function senders(v: unknown, path: string): { connector: string; provider?: string; account?: string }[] {
  return arr(v ?? [], path).map((s, i) => {
    const o = obj(s, `${path}[${i}]`);
    const account = optStr(o['account'], `${path}[${i}].account`);
    const provider = optStr(o['provider'], `${path}[${i}].provider`);
    return {
      connector: str(o['connector'], `${path}[${i}].connector`),
      ...(provider !== undefined ? { provider } : {}),
      ...(account !== undefined ? { account } : {}),
    };
  });
}

export function parseControlInbox(v: unknown): ControlInbox {
  const o = obj(v, 'inbox');
  return {
    batches: arr(o['batches'], 'inbox.batches').map((b, i): InboxBatch => {
      const p = `inbox.batches[${i}]`;
      const x = obj(b, p);
      const state = str(x['state'], `${p}.state`);
      if (state !== 'awaiting_approval' && state !== 'ready_to_start') throw new WireParseError(`${p}.state`, 'a known batch state');
      const a = approval(x['approval'], `${p}.approval`);
      return {
        definitionId: str(x['definitionId'], `${p}.definitionId`),
        workflowName: str(x['workflowName'], `${p}.workflowName`),
        state,
        previewId: str(x['previewId'], `${p}.previewId`),
        certificateId: str(x['certificateId'], `${p}.certificateId`),
        root: str(x['root'], `${p}.root`),
        total: num(x['total'], `${p}.total`),
        counts: counts(x['counts'], `${p}.counts`),
        senders: senders(x['senders'], `${p}.senders`),
        createdBy: str(x['createdBy'], `${p}.createdBy`),
        createdAt: str(x['createdAt'], `${p}.createdAt`),
        expiresAt: str(x['expiresAt'], `${p}.expiresAt`),
        preparedByYou: bool(x['preparedByYou'], `${p}.preparedByYou`),
        ...(a !== undefined ? { approval: a } : {}),
      };
    }),
    steps: arr(o['steps'], 'inbox.steps').map((s, i): InboxStep => {
      const p = `inbox.steps[${i}]`;
      const x = obj(s, p);
      return {
        definitionId: str(x['definitionId'], `${p}.definitionId`),
        workflowName: str(x['workflowName'], `${p}.workflowName`),
        runId: str(x['runId'], `${p}.runId`),
        ...itemRef(x, p),
        approvalId: str(x['approvalId'], `${p}.approvalId`),
        step: str(x['step'], `${p}.step`),
        summary: str(x['summary'], `${p}.summary`),
        proposedActions: strArr(x['proposedActions'] ?? [], `${p}.proposedActions`),
        requestedAt: str(x['requestedAt'], `${p}.requestedAt`),
        expiresAt: str(x['expiresAt'], `${p}.expiresAt`),
      };
    }),
    attention: arr(o['attention'], 'inbox.attention').map((a, i): InboxAttention => {
      const p = `inbox.attention[${i}]`;
      const x = obj(a, p);
      return {
        definitionId: str(x['definitionId'], `${p}.definitionId`),
        workflowName: str(x['workflowName'], `${p}.workflowName`),
        runId: str(x['runId'], `${p}.runId`),
        ...itemRef(x, p),
        step: str(x['step'], `${p}.step`),
        connector: str(x['connector'], `${p}.connector`),
        operation: str(x['operation'], `${p}.operation`),
        state: str(x['state'], `${p}.state`),
        intentAt: str(x['intentAt'], `${p}.intentAt`),
        detail: str(x['detail'] ?? '', `${p}.detail`),
      };
    }),
    truncated: o['truncated'] === true,
  };
}

export function parseBatchPreview(v: unknown, path = 'preview'): BatchPreviewView {
  const o = obj(v, path);
  const a = approval(o['approval'], `${path}.approval`);
  return {
    previewId: str(o['previewId'], `${path}.previewId`),
    definitionId: str(o['definitionId'], `${path}.definitionId`),
    certificateId: str(o['certificateId'], `${path}.certificateId`),
    root: str(o['root'], `${path}.root`),
    forEach: bool(o['forEach'], `${path}.forEach`),
    effects: bool(o['effects'], `${path}.effects`),
    counts: counts(o['counts'], `${path}.counts`),
    senders: senders(o['senders'], `${path}.senders`),
    createdBy: str(o['createdBy'], `${path}.createdBy`),
    createdAt: str(o['createdAt'], `${path}.createdAt`),
    expiresAt: str(o['expiresAt'], `${path}.expiresAt`),
    approvable: bool(o['approvable'], `${path}.approvable`),
    ...(a !== undefined ? { approval: a } : {}),
    page: num(o['page'], `${path}.page`),
    pages: num(o['pages'], `${path}.pages`),
    total: num(o['total'], `${path}.total`),
    items: arr(o['items'], `${path}.items`).map((it, i): PreviewItemView => {
      const p = `${path}.items[${i}]`;
      const x = obj(it, p);
      const state = str(x['state'], `${p}.state`);
      if (!(PREVIEW_ITEM_STATES as readonly string[]).includes(state)) throw new WireParseError(`${p}.state`, 'a known item state');
      const reason = optStr(x['reason'], `${p}.reason`);
      return {
        index: num(x['index'], `${p}.index`),
        state: state as PreviewItemState,
        ...(reason !== undefined ? { reason } : {}),
        approvals: strArr(x['approvals'] ?? [], `${p}.approvals`),
        actions: arr(x['actions'] ?? [], `${p}.actions`).map((ac, j) => {
          const q = `${p}.actions[${j}]`;
          const y = obj(ac, q);
          return {
            step: str(y['step'], `${q}.step`),
            connector: str(y['connector'], `${q}.connector`),
            operation: str(y['operation'], `${q}.operation`),
            sideEffect: str(y['sideEffect'], `${q}.sideEffect`),
            args: obj(y['args'] ?? {}, `${q}.args`),
          };
        }),
      };
    }),
  };
}
