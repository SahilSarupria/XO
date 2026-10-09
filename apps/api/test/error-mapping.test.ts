import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, XoError, NotFoundError, InvalidArgumentError } from '@xo/errors';
import { errorToResponse, knownStatusCodes } from '../src/http/error-mapping.js';

/**
 * The completeness check the brief specifically calls for: "Cover the
 * error-mapping layer especially — that's the part most likely to be
 * silently wrong." A new `ErrorCode` added to `@xo/errors` without a
 * corresponding entry in `STATUS_BY_CODE` would otherwise silently fall
 * through to the generic 500 default — this test turns that into a
 * failing test instead, at the moment the new code is added, not
 * whenever someone happens to notice in production.
 */
test('every ErrorCode value has an explicit HTTP status mapping', () => {
  const known = knownStatusCodes();
  const allCodes = Object.values(ErrorCode);
  assert.ok(allCodes.length > 0, 'sanity check: ErrorCode should not be empty');

  const missing = allCodes.filter((code) => !(code in known));
  assert.deepEqual(missing, [], `these ErrorCode values have no explicit status mapping in error-mapping.ts: ${missing.join(', ')}`);
});

test('every mapped status is a plausible HTTP status code (100-599)', () => {
  const known = knownStatusCodes();
  for (const [code, status] of Object.entries(known)) {
    assert.ok(status >= 100 && status <= 599, `mapped status for ${code} (${status}) is not a valid HTTP status`);
  }
});

test('errorToResponse() maps a XoError to its configured status and a stable JSON error body', () => {
  const error = new NotFoundError('package "foo"');
  const response = errorToResponse(error);
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: { code: ErrorCode.NOT_FOUND, message: 'package "foo" was not found' } });
});

test('errorToResponse() includes non-empty context in the body', () => {
  const error = new InvalidArgumentError('bad input', { context: { field: 'nameAtVersion' } });
  const response = errorToResponse(error);
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: { code: ErrorCode.INVALID_ARGUMENT, message: 'bad input', context: { field: 'nameAtVersion' } } });
});

test('errorToResponse() omits an empty context object from the body rather than emitting context: {}', () => {
  const error = new XoError(ErrorCode.NOT_FOUND, 'nothing here', {});
  const response = errorToResponse(error);
  assert.deepEqual(response.body, { error: { code: ErrorCode.NOT_FOUND, message: 'nothing here' } });
});

test('errorToResponse() falls back to 500 for an XoError whose code somehow has no mapping (defensive default, not reachable via real ErrorCode values today)', () => {
  const error = new XoError('XO_SOME_FUTURE_CODE_NOT_YET_MAPPED' as never, 'unmapped');
  const response = errorToResponse(error);
  assert.equal(response.status, 500);
});

test('errorToResponse() maps a plain Error to a generic 500 without leaking its message', () => {
  const response = errorToResponse(new Error('some internal implementation detail: /etc/secret-path'));
  assert.equal(response.status, 500);
  const body = response.body as { error: { code: string; message: string } };
  assert.equal(body.error.code, ErrorCode.UNKNOWN);
  assert.equal(body.error.message, 'an unexpected error occurred');
  assert.ok(!JSON.stringify(response.body).includes('/etc/secret-path'), 'must never leak an arbitrary thrown Error message');
});

test('errorToResponse() maps a non-Error thrown value (e.g. a string) to a generic 500', () => {
  const response = errorToResponse('a string was thrown, not an Error');
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: { code: ErrorCode.UNKNOWN, message: 'an unexpected error occurred' } });
});

test('spot-check: a representative sample of domain-specific codes map to the reasoned status, not just the 500 default', () => {
  const known = knownStatusCodes();
  assert.equal(known[ErrorCode.RUNTIME_SAFETY_BLOCKED], 403);
  assert.equal(known[ErrorCode.RUNTIME_BUDGET_EXCEEDED], 429);
  assert.equal(known[ErrorCode.PACKAGE_ALREADY_INSTALLED], 409);
  assert.equal(known[ErrorCode.REGISTRY_LEDGER_TAMPERED], 500);
  assert.equal(known[ErrorCode.XOIR_SCHEMA_VERSION_UNSUPPORTED], 400);
  assert.equal(known[ErrorCode.UNIMPLEMENTED], 501);
});

test('P0.8: WORKFLOW_NOT_EXECUTABLE maps to 422 and carries its structured context to the wire', () => {
  assert.equal(knownStatusCodes()[ErrorCode.WORKFLOW_NOT_EXECUTABLE], 422);
  assert.equal(ErrorCode.WORKFLOW_NOT_EXECUTABLE, 'XO_WORKFLOW_NOT_EXECUTABLE');
  const res = errorToResponse(new XoError(ErrorCode.WORKFLOW_NOT_EXECUTABLE, 'not executable', { context: { executabilityStatus: 'not_executable_yet' } }));
  assert.equal(res.status, 422);
  assert.deepEqual(res.body, { error: { code: 'XO_WORKFLOW_NOT_EXECUTABLE', message: 'not executable', context: { executabilityStatus: 'not_executable_yet' } } });
});
