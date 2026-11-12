import type { Attention, SourceState } from './contract.js';
import type { SourceConfig, SourceFacts } from './ports.js';

export interface DerivedState {
  readonly state: SourceState;
  readonly attention?: Attention;
}

/**
 * Pure mapping from platform facts plus Connect's own flag to the state a user sees.
 *
 * Rules (all deliberate):
 *  - Connect's own stop (`disconnected`) wins: reading is stopped regardless of platform state.
 *  - A revoked authorization is `access_ended`. Expiry and revocation are indistinguishable in the inventory today, so the state
 *    never claims which one happened and never claims knowledge was removed.
 *  - Missing platform facts (for example after a restart with no durable inventory) is `setup_incomplete`, never a guessed healthy state.
 *  - `read_complete` requires the platform to report a successful acquisition; Connect's own history is not used as proof.
 */
export function deriveState(config: SourceConfig, facts: SourceFacts | undefined): DerivedState {
  if (config.disconnected) return { state: 'disconnected' };
  if (facts === undefined)
    return {
      state: 'setup_incomplete',
      attention: {
        code: 'platform_record_missing',
        message: 'XO has no current record of this folder. Check it again to re-establish it.',
      },
    };
  if (facts.authorization === 'revoked' && facts.endedReason === 'expired')
    return {
      state: 'access_expired',
      attention: {
        code: 'access_expired',
        message:
          'XO can no longer read this source. Earlier knowledge is kept and may be out of date until you reconnect or remove the source.',
      },
    };
  if (facts.authorization === 'revoked')
    return {
      state: 'access_ended',
      attention: {
        code: 'access_ended',
        message:
          'XO can no longer read this folder. Earlier knowledge is kept and may be out of date until you reconnect or remove the source.',
      },
    };
  if (facts.authorization === 'denied')
    return {
      state: 'needs_attention',
      attention: { code: 'access_denied', message: 'Access to this folder was not granted. Nothing was read.' },
    };
  if (facts.connection === 'failed' || facts.acquisition === 'failed' || facts.unavailable)
    return {
      state: 'needs_attention',
      attention: {
        code: facts.unavailable ? 'source_unavailable' : 'read_failed',
        message: facts.unavailable ? 'This folder is not reachable right now.' : 'The last read of this folder failed.',
      },
    };
  if (facts.authorization !== 'granted' || facts.connection === 'not_planned' || facts.connection === 'required')
    return { state: 'setup_incomplete', attention: { code: 'setup_incomplete', message: 'Setup for this folder is not finished.' } };
  // The platform's acquisition axis also records a successful DISCOVERY (listing), so it cannot prove content was read. The state of the
  // last content read comes from Connect's own recorded read, and a source with no recorded read is still awaiting its first one.
  const lastRead = [...config.history].reverse().find((h) => h.kind === 'read')?.read;
  if (lastRead === undefined) return { state: 'awaiting_first_read' };
  if (lastRead.status === 'failed')
    return { state: 'needs_attention', attention: { code: 'read_failed', message: 'The last read of this folder failed.' } };
  if (lastRead.status === 'partial' || facts.acquisition === 'partial')
    return { state: 'read_partial', attention: { code: 'read_partial', message: 'Some items could not be read.' } };
  return { state: 'read_complete' };
}
