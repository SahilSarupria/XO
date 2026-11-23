/**
 * UW-12b (ADR 0047) — the control surface as Studio reads it: the workspace's runtime inbox, a batch preview and its approval.
 * Parsed strictly. Studio only shows what the platform says and sends a person's decision back; the platform decides everything
 * again (role, recent sign-in, separation of duties, the root the person saw).
 */
import { WireParseError, arr, bool, num, obj, optStr, str, strArr } from './wire';

export const PREVIEW_ITEM_STATES = ['sends', 'no_effect', 'stops', 'not_exact'] as const;
export type PreviewItemState = (typeof PREVIEW_ITEM_STATES)[number];
export type PreviewCounts = Readonly<Record<PreviewItemState, number>>;

/** Who would send: the connector, the account its owner recognises, and for email the tier it sends in (UAC-32). */
export interface SenderLine {
  readonly connector: string;
  readonly provider?: string;
  readonly account?: string;
  readonly tier?: string;
  readonly tierExplanation?: string;
}

export interface BatchApprovalView {
  readonly approvalId: string;
  readonly reviewerId: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly usedBy?: string;
  /** UW-16a: the steps this approval also decides, for each item. Absent on an approval from before UW-16a, which decided all of them. */
  readonly presignSteps?: readonly string[];
}

/** UW-16a: a step a person does for each item, and how many items reach it. */
export interface StepToApproveView {
  readonly step: string;
  readonly summary: string;
  readonly items: number;
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
  readonly senders: readonly SenderLine[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly preparedByYou: boolean;
  readonly approval?: BatchApprovalView;
  /** UW-16b: this batch is here because a run under a standing approval went outside its bounds. */
  readonly standingFallback?: StandingFallbackRef;
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
  /** UW-16b. Absent from a platform that predates standing approvals. */
  readonly standing: StandingInbox;
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
  readonly senders: readonly SenderLine[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly approvable: boolean;
  readonly approval?: BatchApprovalView;
  readonly standingFallback?: StandingFallbackRef;
  /** V1-1 (ADR 0049): the items were built from this confirmed source, leaving these rows out. */
  readonly itemsSource?: PreviewItemsSourceView;
  /** UW-16a: the steps a person does for each item (the approver may decide them with the batch). */
  readonly stepsToApprove: readonly StepToApproveView[];
  readonly page: number;
  readonly pages: number;
  readonly total: number;
  readonly items: readonly PreviewItemView[];
}

export interface PreviewItemsSourceView {
  readonly label: string;
  readonly connectionName: string;
  readonly changedSinceConfirmation: boolean;
  readonly items: number;
  readonly excludedRows: number;
  readonly loose: number;
  /** Why rows were left out, counted by reason (from the bounded list the platform returns). */
  readonly reasons: Readonly<Record<string, number>>;
}

function itemsSource(v: unknown, path: string): PreviewItemsSourceView | undefined {
  if (v === undefined) return undefined;
  const o = obj(v, path);
  const c = obj(o['counts'], `${path}.counts`);
  const reasons: Record<string, number> = {};
  for (const [i, r] of arr(o['excludedRows'] ?? [], `${path}.excludedRows`).entries()) {
    const why = str(obj(r, `${path}.excludedRows[${i}]`)['reason'], `${path}.excludedRows[${i}].reason`);
    reasons[why] = (reasons[why] ?? 0) + 1;
  }
  return {
    label: str(o['label'], `${path}.label`),
    connectionName: str(o['connectionName'], `${path}.connectionName`),
    changedSinceConfirmation: bool(o['changedSinceConfirmation'], `${path}.changedSinceConfirmation`),
    items: num(c['items'], `${path}.counts.items`),
    excludedRows: num(c['excludedRows'], `${path}.counts.excludedRows`),
    loose: num(c['loose'], `${path}.counts.loose`),
    reasons,
  };
}

/** V1-1: a confirmed list or pairing a once-per-item workflow can take its items from. */
export interface ItemSourceView {
  readonly connectionId: string;
  readonly proposalId: string;
  readonly role: string;
  readonly label: string;
  readonly connectionName: string;
  readonly items: number;
  readonly excluded: number;
  readonly missingFields: readonly string[];
  readonly usable: boolean;
}

export interface ItemSourcesView {
  readonly forEach: boolean;
  readonly fieldsUsed: readonly string[];
  readonly sources: readonly ItemSourceView[];
}

export function parseItemSources(v: unknown, path = 'itemSources'): ItemSourcesView {
  const o = obj(v, path);
  return {
    forEach: bool(o['forEach'], `${path}.forEach`),
    fieldsUsed: strArr(o['fieldsUsed'] ?? [], `${path}.fieldsUsed`),
    sources: arr(o['sources'], `${path}.sources`).map((x, i) => {
      const p = `${path}.sources[${i}]`;
      const y = obj(x, p);
      return {
        connectionId: str(y['connectionId'], `${p}.connectionId`),
        proposalId: str(y['proposalId'], `${p}.proposalId`),
        role: str(y['role'], `${p}.role`),
        label: str(y['label'], `${p}.label`),
        connectionName: str(y['connectionName'], `${p}.connectionName`),
        items: num(y['items'], `${p}.items`),
        excluded: num(y['excluded'], `${p}.excluded`),
        missingFields: strArr(y['missingFields'] ?? [], `${p}.missingFields`),
        usable: bool(y['usable'], `${p}.usable`),
      };
    }),
  };
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
  const presign = o['presignSteps'] === undefined ? undefined : strArr(o['presignSteps'], `${path}.presignSteps`);
  return {
    ...(presign !== undefined ? { presignSteps: presign } : {}),
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

function senders(v: unknown, path: string): SenderLine[] {
  return arr(v ?? [], path).map((s, i) => {
    const o = obj(s, `${path}[${i}]`);
    const opt = (k: string) => optStr(o[k], `${path}[${i}].${k}`);
    const [account, provider, tier, tierExplanation] = [opt('account'), opt('provider'), opt('tier'), opt('tierExplanation')];
    return {
      connector: str(o['connector'], `${path}[${i}].connector`),
      ...(provider !== undefined ? { provider } : {}),
      ...(account !== undefined ? { account } : {}),
      ...(tier !== undefined ? { tier } : {}),
      ...(tierExplanation !== undefined ? { tierExplanation } : {}),
    };
  });
}

export function parseControlInbox(v: unknown): ControlInbox {
  const o = obj(v, 'inbox');
  return {
    standing: parseStandingInbox(o['standing'], 'inbox.standing'),
    batches: arr(o['batches'], 'inbox.batches').map((b, i): InboxBatch => {
      const p = `inbox.batches[${i}]`;
      const x = obj(b, p);
      const state = str(x['state'], `${p}.state`);
      if (state !== 'awaiting_approval' && state !== 'ready_to_start') throw new WireParseError(`${p}.state`, 'a known batch state');
      const a = approval(x['approval'], `${p}.approval`);
      const fb = fallbackRef(x['standingFallback'], `${p}.standingFallback`);
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
        ...(fb !== undefined ? { standingFallback: fb } : {}),
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
  const src = itemsSource(o['itemsSource'], `${path}.itemsSource`);
  const fb = fallbackRef(o['standingFallback'], `${path}.standingFallback`);
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
    ...(src !== undefined ? { itemsSource: src } : {}),
    ...(fb !== undefined ? { standingFallback: fb } : {}),
    stepsToApprove: arr(o['stepsToApprove'] ?? [], `${path}.stepsToApprove`).map((x, i) => {
      const q = `${path}.stepsToApprove[${i}]`;
      const y = obj(x, q);
      return { step: str(y['step'], `${q}.step`), summary: str(y['summary'], `${q}.summary`), items: num(y['items'], `${q}.items`) };
    }),
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

// ------------------------------------------------------------------------------------------------ UW-16c (ADR 0051): standing approvals

/** Why a run under a standing approval became a batch that waits for a person. The reasons are the platform's codes; the UI words them. */
export interface StandingFallbackRef {
  readonly standingApprovalId: string;
  readonly reasons: readonly string[];
}

function fallbackRef(v: unknown, path: string): StandingFallbackRef | undefined {
  if (v === undefined) return undefined;
  const o = obj(v, path);
  return {
    standingApprovalId: str(o['standingApprovalId'], `${path}.standingApprovalId`),
    reasons: strArr(o['reasons'], `${path}.reasons`),
  };
}

export const STANDING_STATUSES = ['proposed', 'changes_requested', 'active', 'expired', 'revoked'] as const;
export type StandingStatus = (typeof STANDING_STATUSES)[number];
export const STANDING_PERIODS = ['day', 'week', 'month'] as const;
export type StandingPeriod = (typeof STANDING_PERIODS)[number];
export type StandingTrigger = 'manual' | 'schedule';

export interface StandingLimitsView {
  readonly maxItemsPerRun: number;
  readonly maxItemsPerPeriod: number;
  readonly maxRunsPerPeriod: number;
  readonly period: StandingPeriod;
  readonly maxExcludedRows: number;
}

export interface StandingArgumentRef {
  readonly step: string;
  readonly argument: string;
}

export interface StandingView {
  readonly standingApprovalId: string;
  readonly status: StandingStatus;
  readonly definitionId: string;
  readonly certificateId: string;
  /** What an approver approves: sent back, so the platform can tell they saw this policy. */
  readonly policyDigest: string;
  readonly items: { readonly kind: 'source'; readonly connectionId: string; readonly proposalId: string } | { readonly kind: 'input' };
  readonly effects: readonly { readonly connector: string; readonly operation: string; readonly sideEffect: string }[];
  /** Counts of fixed values per argument, never the values. */
  readonly pinned: readonly (StandingArgumentRef & { readonly count: number })[];
  readonly mayVary: readonly StandingArgumentRef[];
  readonly presignSteps: readonly string[];
  readonly limits: StandingLimitsView;
  readonly triggers: readonly StandingTrigger[];
  readonly startsAs: { readonly id: string };
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly sample: { readonly previewId: string; readonly root: string; readonly items: number };
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly note?: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly selfApproved?: boolean;
  readonly changesRequested?: { readonly comment: string; readonly at: string };
  readonly revoked?: { readonly at: string; readonly reason: string };
  /** In the current period (list and detail only). */
  readonly usage?: { readonly period: StandingPeriod; readonly runs: number; readonly items: number };
  readonly uses: readonly { readonly runId: string; readonly items: number; readonly at: string }[];
  readonly fallbacks: readonly {
    readonly at: string;
    readonly trigger: string;
    readonly reasons: readonly string[];
    readonly previewId?: string;
  }[];
}

export interface StandingInbox {
  readonly proposals: readonly {
    readonly standingApprovalId: string;
    readonly definitionId: string;
    readonly items: number;
    readonly preparedByYou: boolean;
    readonly proposedAt: string;
  }[];
  readonly expiring: readonly { readonly standingApprovalId: string; readonly expiresAt: string }[];
  readonly fallbacks: readonly {
    readonly standingApprovalId: string;
    readonly previewId?: string;
    readonly reasons: readonly string[];
    readonly at: string;
  }[];
}

function parseStandingInbox(v: unknown, path: string): StandingInbox {
  if (v === undefined) return { proposals: [], expiring: [], fallbacks: [] };
  const o = obj(v, path);
  return {
    proposals: arr(o['proposals'], `${path}.proposals`).map((x, i) => {
      const p = `${path}.proposals[${i}]`;
      const y = obj(x, p);
      return {
        standingApprovalId: str(y['standingApprovalId'], `${p}.standingApprovalId`),
        definitionId: str(y['definitionId'], `${p}.definitionId`),
        items: num(y['items'], `${p}.items`),
        preparedByYou: bool(y['preparedByYou'], `${p}.preparedByYou`),
        proposedAt: str(y['proposedAt'], `${p}.proposedAt`),
      };
    }),
    expiring: arr(o['expiring'], `${path}.expiring`).map((x, i) => {
      const p = `${path}.expiring[${i}]`;
      const y = obj(x, p);
      return {
        standingApprovalId: str(y['standingApprovalId'], `${p}.standingApprovalId`),
        expiresAt: str(y['expiresAt'], `${p}.expiresAt`),
      };
    }),
    fallbacks: arr(o['fallbacks'], `${path}.fallbacks`).map((x, i) => {
      const p = `${path}.fallbacks[${i}]`;
      const y = obj(x, p);
      const previewId = optStr(y['previewId'], `${p}.previewId`);
      return {
        standingApprovalId: str(y['standingApprovalId'], `${p}.standingApprovalId`),
        ...(previewId !== undefined ? { previewId } : {}),
        reasons: strArr(y['reasons'], `${p}.reasons`),
        at: str(y['at'], `${p}.at`),
      };
    }),
  };
}

const argRef = (v: unknown, p: string): StandingArgumentRef => {
  const o = obj(v, p);
  return { step: str(o['step'], `${p}.step`), argument: str(o['argument'], `${p}.argument`) };
};

export function parseStanding(v: unknown, path = 'standingApproval'): StandingView {
  const o = obj(v, path);
  const status = str(o['status'], `${path}.status`);
  if (!(STANDING_STATUSES as readonly string[]).includes(status))
    throw new WireParseError(`${path}.status`, 'a known standing approval status');
  const limits = obj(o['limits'], `${path}.limits`);
  const period = str(limits['period'], `${path}.limits.period`);
  if (!(STANDING_PERIODS as readonly string[]).includes(period)) throw new WireParseError(`${path}.limits.period`, 'day, week or month');
  const items = obj(o['items'], `${path}.items`);
  const kind = str(items['kind'], `${path}.items.kind`);
  if (kind !== 'source' && kind !== 'input') throw new WireParseError(`${path}.items.kind`, 'source or input');
  const triggers = strArr(o['triggers'], `${path}.triggers`).map((t) => {
    if (t !== 'manual' && t !== 'schedule') throw new WireParseError(`${path}.triggers`, 'manual or schedule');
    return t as StandingTrigger;
  });
  const sample = obj(o['sample'], `${path}.sample`);
  const note = optStr(o['note'], `${path}.note`);
  const approvedBy = optStr(o['approvedBy'], `${path}.approvedBy`);
  const approvedAt = optStr(o['approvedAt'], `${path}.approvedAt`);
  const ch = o['changesRequested'] === undefined ? undefined : obj(o['changesRequested'], `${path}.changesRequested`);
  const rv = o['revoked'] === undefined ? undefined : obj(o['revoked'], `${path}.revoked`);
  const us = o['usage'] === undefined ? undefined : obj(o['usage'], `${path}.usage`);
  return {
    standingApprovalId: str(o['standingApprovalId'], `${path}.standingApprovalId`),
    status: status as StandingStatus,
    definitionId: str(o['definitionId'], `${path}.definitionId`),
    certificateId: str(o['certificateId'], `${path}.certificateId`),
    policyDigest: str(o['policyDigest'], `${path}.policyDigest`),
    items:
      kind === 'source'
        ? {
            kind,
            connectionId: str(items['connectionId'], `${path}.items.connectionId`),
            proposalId: str(items['proposalId'], `${path}.items.proposalId`),
          }
        : { kind },
    effects: arr(o['effects'] ?? [], `${path}.effects`).map((x, i) => {
      const p = `${path}.effects[${i}]`;
      const y = obj(x, p);
      return {
        connector: str(y['connector'], `${p}.connector`),
        operation: str(y['operation'], `${p}.operation`),
        sideEffect: str(y['sideEffect'], `${p}.sideEffect`),
      };
    }),
    pinned: arr(o['pinned'] ?? [], `${path}.pinned`).map((x, i) => ({
      ...argRef(x, `${path}.pinned[${i}]`),
      count: num(obj(x, `${path}.pinned[${i}]`)['count'], `${path}.pinned[${i}].count`),
    })),
    mayVary: arr(o['mayVary'] ?? [], `${path}.mayVary`).map((x, i) => argRef(x, `${path}.mayVary[${i}]`)),
    presignSteps: strArr(o['presignSteps'] ?? [], `${path}.presignSteps`),
    limits: {
      maxItemsPerRun: num(limits['maxItemsPerRun'], `${path}.limits.maxItemsPerRun`),
      maxItemsPerPeriod: num(limits['maxItemsPerPeriod'], `${path}.limits.maxItemsPerPeriod`),
      maxRunsPerPeriod: num(limits['maxRunsPerPeriod'], `${path}.limits.maxRunsPerPeriod`),
      period: period as StandingPeriod,
      maxExcludedRows: num(limits['maxExcludedRows'] ?? 0, `${path}.limits.maxExcludedRows`),
    },
    triggers,
    startsAs: { id: str(obj(o['startsAs'], `${path}.startsAs`)['id'], `${path}.startsAs.id`) },
    notBefore: str(o['notBefore'], `${path}.notBefore`),
    expiresAt: str(o['expiresAt'], `${path}.expiresAt`),
    sample: {
      previewId: str(sample['previewId'], `${path}.sample.previewId`),
      root: str(sample['root'], `${path}.sample.root`),
      items: num(sample['items'], `${path}.sample.items`),
    },
    proposedBy: str(o['proposedBy'], `${path}.proposedBy`),
    proposedAt: str(o['proposedAt'], `${path}.proposedAt`),
    ...(note !== undefined ? { note } : {}),
    ...(approvedBy !== undefined ? { approvedBy } : {}),
    ...(approvedAt !== undefined ? { approvedAt } : {}),
    ...(o['selfApproved'] === true ? { selfApproved: true } : {}),
    ...(ch !== undefined
      ? {
          changesRequested: {
            comment: str(ch['comment'], `${path}.changesRequested.comment`),
            at: str(ch['at'], `${path}.changesRequested.at`),
          },
        }
      : {}),
    ...(rv !== undefined
      ? { revoked: { at: str(rv['at'], `${path}.revoked.at`), reason: str(rv['reason'], `${path}.revoked.reason`) } }
      : {}),
    ...(us !== undefined
      ? {
          usage: {
            period: (STANDING_PERIODS as readonly string[]).includes(str(us['period'], `${path}.usage.period`))
              ? (us['period'] as StandingPeriod)
              : (() => {
                  throw new WireParseError(`${path}.usage.period`, 'day, week or month');
                })(),
            runs: num(us['runs'], `${path}.usage.runs`),
            items: num(us['items'], `${path}.usage.items`),
          },
        }
      : {}),
    uses: arr(o['uses'] ?? [], `${path}.uses`).map((x, i) => {
      const p = `${path}.uses[${i}]`;
      const y = obj(x, p);
      return { runId: str(y['runId'], `${p}.runId`), items: num(y['items'], `${p}.items`), at: str(y['at'], `${p}.at`) };
    }),
    fallbacks: arr(o['fallbacks'] ?? [], `${path}.fallbacks`).map((x, i) => {
      const p = `${path}.fallbacks[${i}]`;
      const y = obj(x, p);
      const previewId = optStr(y['previewId'], `${p}.previewId`);
      return {
        at: str(y['at'], `${p}.at`),
        trigger: str(y['trigger'], `${p}.trigger`),
        reasons: strArr(y['reasons'], `${p}.reasons`),
        ...(previewId !== undefined ? { previewId } : {}),
      };
    }),
  };
}

export function parseStandingList(v: unknown): StandingView[] {
  return arr(obj(v, 'standingApprovals')['standingApprovals'], 'standingApprovals.standingApprovals').map((x, i) =>
    parseStanding(x, `standingApprovals[${i}]`),
  );
}

/** The 202 of a start under a standing approval that went outside its bounds, or the run it started. */
export type StandingStart =
  | { readonly kind: 'started'; readonly runId: string; readonly state: string }
  | { readonly kind: 'fallback'; readonly reasons: readonly string[]; readonly previewId?: string };

export function parseStandingStart(v: unknown): StandingStart {
  const o = obj(v, 'start');
  if (o['fallback'] === true) {
    const previewId = optStr(o['previewId'], 'start.previewId');
    return { kind: 'fallback', reasons: strArr(o['reasons'], 'start.reasons'), ...(previewId !== undefined ? { previewId } : {}) };
  }
  return { kind: 'started', runId: str(o['runId'], 'start.runId'), state: str(o['state'], 'start.state') };
}
