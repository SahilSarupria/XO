import { createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, type FieldSpec, type ReviewerRole, type Scalar } from '@xo/workflow-ir';

/**
 * Human approval, backend only. An approve step parks its run and produces an ApprovalRequest; a reviewer answers with a
 * SIGNED decision. The runner verifies identity, role, signature, expiry and single use before the run moves. Timeouts
 * escalate; there is no auto-approve path anywhere.
 */

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly runId: string;
  readonly workflow: string;
  readonly version: string;
  readonly step: string;
  readonly roles: readonly ReviewerRole[];
  readonly summary: string;
  /** The case: the step's input values, verbatim. */
  readonly case: Readonly<Record<string, unknown>>;
  /** Input names the author marked as evidence (quoted source text, extracted facts ...), verbatim. */
  readonly evidence: Readonly<Record<string, unknown>>;
  /** Decision trace: which rules/branches upstream decide steps fired. */
  readonly trace: readonly { readonly step: string; readonly rulesFired: readonly string[] }[];
  /** What happens if approved, as declared by the workflow (the connector operations that depend on this step). */
  readonly proposedActions: readonly string[];
  readonly allowEdit: boolean;
  /** Output fields a reviewer may supply with edit_and_approve. */
  readonly editable: Readonly<Record<string, FieldSpec>>;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

export type DecisionAction = 'approve' | 'reject' | 'edit_and_approve';

export interface DecisionPayload {
  readonly v: 1;
  readonly approvalId: string;
  readonly runId: string;
  readonly step: string;
  readonly action: DecisionAction;
  readonly edits: Readonly<Record<string, Scalar>>;
  readonly reviewerId: string;
  readonly at: string;
  readonly comment?: string;
}

export interface SignedDecision {
  readonly payload: DecisionPayload;
  /** base64 Ed25519 signature over canonicalJson(payload). */
  readonly signature: string;
}

export interface Reviewer {
  readonly id: string;
  readonly roles: readonly ReviewerRole[];
  readonly publicKeyPem: string;
  readonly revoked?: boolean;
}

export interface ReviewerRegistry {
  get(id: string): Reviewer | undefined;
}

export class StaticReviewerRegistry implements ReviewerRegistry {
  private readonly m = new Map<string, Reviewer>();
  constructor(reviewers: readonly Reviewer[]) {
    for (const r of reviewers) this.m.set(r.id, r);
  }
  get(id: string): Reviewer | undefined {
    return this.m.get(id);
  }
}

export function generateReviewerKeys(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function signDecision(privateKeyPem: string, payload: DecisionPayload): SignedDecision {
  return { payload, signature: edSign(null, Buffer.from(canonicalJson(payload)), privateKeyPem).toString('base64') };
}

export type DecisionRefusal =
  | 'UNKNOWN_APPROVAL'
  | 'ALREADY_DECIDED'
  | 'EXPIRED'
  | 'UNKNOWN_REVIEWER'
  | 'REVOKED_REVIEWER'
  | 'BAD_SIGNATURE'
  | 'ROLE_NOT_PERMITTED'
  | 'BINDING_MISMATCH'
  | 'EDIT_NOT_ALLOWED'
  | 'BAD_EDIT'
  | 'BAD_ACTION';

export class ApprovalError extends Error {
  constructor(
    readonly code: DecisionRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

/** Pure verification of a signed decision against a request. Throws ApprovalError; returns the reviewer role used. */
export function verifyDecision(
  req: ApprovalRequest,
  d: SignedDecision,
  registry: ReviewerRegistry,
  nowMs: number,
): { role: ReviewerRole; outputs: Record<string, Scalar> } {
  const p = d.payload;
  if (p.v !== 1 || p.approvalId !== req.approvalId || p.runId !== req.runId || p.step !== req.step)
    throw new ApprovalError('BINDING_MISMATCH', 'decision is not bound to this approval request (id, run or step differ)');
  if (nowMs > Date.parse(req.expiresAt)) throw new ApprovalError('EXPIRED', 'approval request has expired and was escalated');
  if (p.action !== 'approve' && p.action !== 'reject' && p.action !== 'edit_and_approve')
    throw new ApprovalError('BAD_ACTION', 'unknown action');
  const reviewer = registry.get(p.reviewerId);
  if (reviewer === undefined) throw new ApprovalError('UNKNOWN_REVIEWER', `reviewer "${p.reviewerId}" is not in the trust registry`);
  if (reviewer.revoked === true) throw new ApprovalError('REVOKED_REVIEWER', `reviewer "${p.reviewerId}" is revoked`);
  let ok = false;
  try {
    ok = edVerify(null, Buffer.from(canonicalJson(p)), createPublicKey(reviewer.publicKeyPem), Buffer.from(d.signature, 'base64'));
  } catch {
    ok = false;
  }
  if (!ok) throw new ApprovalError('BAD_SIGNATURE', 'signature does not verify for this reviewer');
  // auditors are read-only by definition, even if a workflow lists the role
  const role = reviewer.roles.find((r) => r !== 'auditor' && req.roles.includes(r));
  if (role === undefined)
    throw new ApprovalError(
      'ROLE_NOT_PERMITTED',
      `reviewer "${reviewer.id}" holds no role permitted for this step (${req.roles.join(', ')}; auditors cannot decide)`,
    );
  const outputs: Record<string, Scalar> = {};
  const edits = p.edits ?? {};
  if (p.action === 'edit_and_approve') {
    if (!req.allowEdit) throw new ApprovalError('EDIT_NOT_ALLOWED', 'this step does not allow edits');
    for (const [k, v] of Object.entries(edits)) {
      const spec = req.editable[k];
      if (spec === undefined) throw new ApprovalError('BAD_EDIT', `"${k}" is not an editable output`);
      if (!fits(spec, v)) throw new ApprovalError('BAD_EDIT', `edit for "${k}" does not match its declared type`);
      outputs[k] = v;
    }
  } else if (Object.keys(edits).length > 0) throw new ApprovalError('EDIT_NOT_ALLOWED', 'edits are only accepted with edit_and_approve');
  outputs['decision'] = p.action === 'reject' ? 'rejected' : 'approved';
  for (const [k, spec] of Object.entries(req.editable)) {
    if (k in outputs) continue;
    if (p.action !== 'reject' && spec.nullable !== true)
      throw new ApprovalError('BAD_EDIT', `output "${k}" must be supplied with edit_and_approve`);
    outputs[k] = null;
  }
  return { role, outputs };
}

function fits(spec: FieldSpec, v: unknown): boolean {
  if (v === null) return spec.nullable === true;
  switch (spec.type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'enum':
      return typeof v === 'string' && (spec.enum ?? []).includes(v);
    case 'json':
      return false; // free-form JSON edits are not accepted from reviewers
  }
}

/** Delivery for a new request. The directory sink writes `<dir>/<approvalId>.json` atomically for a frontend or poller to pick up. */
export type ApprovalSink = (r: ApprovalRequest) => void | Promise<void>;

export function directoryApprovalSink(dir: string): ApprovalSink {
  return async (r) => {
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${r.approvalId}.tmp`);
    await writeFile(tmp, `${JSON.stringify(r, null, 2)}\n`, { flag: 'w' });
    await rename(tmp, join(dir, `${r.approvalId}.json`));
  };
}
