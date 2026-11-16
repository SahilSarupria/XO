// UW-1 — step-up configuration and the credential rules (API keys are not interactive; 0 turns step-up off).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '@xo/errors';
import { DEFAULT_STEP_UP_MAX_AGE_MINUTES, parseStepUpMaxAgeMinutes, requireRecentAuthentication } from '../src/auth/step-up.js';
import type { ApiRequest } from '../src/http/types.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import { withTempDir } from './test-helpers.js';

test('XO_API_STEP_UP_MAX_AGE_MINUTES: default 15, 0 = off, 1 to 1440, anything else stops startup', () => {
  assert.equal(parseStepUpMaxAgeMinutes(undefined), DEFAULT_STEP_UP_MAX_AGE_MINUTES);
  assert.equal(DEFAULT_STEP_UP_MAX_AGE_MINUTES, 15);
  assert.equal(parseStepUpMaxAgeMinutes('0'), 0);
  assert.equal(parseStepUpMaxAgeMinutes('1440'), 1440);
  for (const bad of ['1441', '-1', '2.5', 'soon']) assert.throws(() => parseStepUpMaxAgeMinutes(bad), /STEP_UP/);
});

test('API keys are not asked to step up; a window of 0 asks nobody; an old or unknown sign-in is refused', async () => {
  await withTempDir('xo-step-up-', async (dir) => {
    const workspace = { workspaceId: 'ws_step', identityId: 'alice', createdAt: new Date().toISOString() } as unknown as WorkspaceRecord;
    const config = { dataRootDir: dir } as never;
    const req = (authentication: ApiRequest['authentication'], stepUpMaxAgeMinutes?: number): ApiRequest =>
      ({
        authentication,
        identity: { identityId: 'alice' },
        ...(stepUpMaxAgeMinutes !== undefined ? { stepUpMaxAgeMinutes } : {}),
      }) as ApiRequest;
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

    await requireRecentAuthentication(req({ credential: 'api-key' }), workspace, config, 'approve');
    await requireRecentAuthentication(req({ credential: 'session', issuer: 'i', authenticatedAt: ago(5) }), workspace, config, 'approve');
    await requireRecentAuthentication(
      req({ credential: 'session', issuer: 'i', authenticatedAt: ago(500) }, 0),
      workspace,
      config,
      'approve',
    );
    await requireRecentAuthentication(
      req({ credential: 'session', issuer: 'i', authenticatedAt: ago(50) }, 60),
      workspace,
      config,
      'approve',
    );
    for (const auth of [
      { credential: 'session', issuer: 'i', authenticatedAt: ago(16) },
      { credential: 'oidc', issuer: 'i' },
      { credential: 'session', issuer: 'i', authenticatedAt: 'not a time' },
    ] as const) {
      await assert.rejects(
        requireRecentAuthentication(req(auth), workspace, config, 'approve'),
        (e: { code?: string }) => e.code === ErrorCode.AUTH_STEP_UP_REQUIRED,
        JSON.stringify(auth),
      );
    }
  });
});
