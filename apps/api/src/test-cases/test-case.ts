import { ErrorCode, XoError } from '@xo/errors';

/**
 * Saved test cases for one capability of one stored compilation. A case is data the author wrote; a run of it is a
 * real, approval-gated execution (see executions/run-execution.ts) whose outcome the platform compares with the
 * case's expectation. Pass/fail is computed here, on the server, from the persisted execution record.
 */
export const MAX_CASES_PER_CAPABILITY = 100;
export const MAX_RUNS_PER_CASE = 50;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_EXPECTED_OUTPUT_BYTES = 16 * 1024;

export type ExpectedStatus = 'succeeded' | 'waiting_for_human' | 'failed';
export const EXPECTED_STATUSES: readonly ExpectedStatus[] = ['succeeded', 'waiting_for_human', 'failed'];

export interface TestCaseExpectation {
  readonly status: ExpectedStatus;
  /** Optional subset: every key/value listed must appear (recursively) in the actual output; extra actual keys are fine. */
  readonly output?: Readonly<Record<string, unknown>>;
}

export interface TestCaseInput {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly expected: TestCaseExpectation;
}

export interface TestCase extends TestCaseInput {
  readonly caseId: string;
  readonly workspaceId: string;
  readonly compilationId: string;
  readonly capabilityId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface TestCaseRun {
  readonly runId: string;
  readonly caseId: string;
  /** Revision of the case that was run, so history stays interpretable after the case is edited. */
  readonly caseRevision: number;
  readonly executionId: string;
  readonly at: string;
  readonly ranBy: string;
  readonly pass: boolean;
  /** What the platform observed. `output` is the execution's recorded output, verbatim. */
  readonly actual: {
    readonly status: string;
    readonly output?: unknown;
    readonly errorCode?: string;
    readonly errorMessage?: string;
  };
  /** Human-readable reasons the run did not match the expectation; empty when it passed. */
  readonly mismatches: readonly string[];
}

const invalid = (message: string): never => {
  throw new XoError(ErrorCode.INVALID_ARGUMENT, message);
};

function plainObject(value: unknown, where: string, maxBytes: number): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(`"${where}" must be a JSON object`);
  if (JSON.stringify(value).length > maxBytes) return invalid(`"${where}" must be at most ${maxBytes} bytes serialized`);
  return value as Record<string, unknown>;
}

function rejectUnknown(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(o).filter((k) => !allowed.includes(k));
  if (unknown.length > 0)
    invalid(`unknown field(s) in ${where}: ${unknown.map((k) => `"${k}"`).join(', ')}. Allowed: ${allowed.join(', ')}`);
}

/** Strict body parser for create and update. `expectedRevision` is only meaningful on update and is returned separately. */
export function parseTestCaseInput(
  raw: unknown,
  { update }: { readonly update: boolean },
): { input: TestCaseInput; expectedRevision?: number } {
  const o = plainObject(raw, 'body', 256 * 1024);
  rejectUnknown(o, update ? ['name', 'input', 'expected', 'expectedRevision'] : ['name', 'input', 'expected'], 'a test case');
  const name = o['name'];
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 120)
    invalid('"name" must be a non-empty string of at most 120 characters');
  const input = plainObject(o['input'] ?? {}, 'input', MAX_INPUT_BYTES);
  const exp = plainObject(o['expected'], 'expected', MAX_EXPECTED_OUTPUT_BYTES + 1024);
  rejectUnknown(exp, ['status', 'output'], '"expected"');
  const status = exp['status'];
  if (typeof status !== 'string' || !(EXPECTED_STATUSES as readonly string[]).includes(status))
    invalid(`"expected.status" must be one of: ${EXPECTED_STATUSES.join(', ')}`);
  const output = exp['output'] === undefined ? undefined : plainObject(exp['output'], 'expected.output', MAX_EXPECTED_OUTPUT_BYTES);
  let expectedRevision: number | undefined;
  if (update && o['expectedRevision'] !== undefined) {
    const r = o['expectedRevision'];
    if (typeof r !== 'number' || !Number.isInteger(r) || r < 1) invalid('"expectedRevision" must be a positive integer');
    expectedRevision = r as number;
  }
  return {
    input: {
      name: (name as string).trim(),
      input,
      expected: { status: status as ExpectedStatus, ...(output !== undefined ? { output } : {}) },
    },
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  };
}

function subsetMismatches(actual: unknown, expected: unknown, path: string, out: string[]): void {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      out.push(`${path}: expected an object, got ${JSON.stringify(actual)}`);
      return;
    }
    for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
      if (!(k in (actual as Record<string, unknown>)))
        out.push(`${path}.${k}: expected ${JSON.stringify(v)}, but the output has no "${k}"`);
      else subsetMismatches((actual as Record<string, unknown>)[k], v, `${path}.${k}`, out);
    }
    return;
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    out.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** The comparison the platform makes. Pure: same execution outcome and expectation always give the same verdict. */
export function judge(expected: TestCaseExpectation, actual: TestCaseRun['actual']): { pass: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  if (actual.status !== expected.status) {
    mismatches.push(
      `status: expected "${expected.status}", got "${actual.status}"${actual.errorMessage !== undefined ? ` (${actual.errorMessage})` : ''}`,
    );
  }
  if (expected.output !== undefined) {
    if (actual.output === undefined) mismatches.push('output: expected values, but the run recorded no output');
    else subsetMismatches(actual.output, expected.output, 'output', mismatches);
  }
  return { pass: mismatches.length === 0, mismatches };
}
