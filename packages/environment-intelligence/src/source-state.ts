import { err, ok, type Result } from '@xo/types';
import { DiscoveryErrorCode, discoveryError, type DiscoveryError } from './errors.js';

/**
 * Source lifecycle as SEPARATE facts, never one "connected" flag
 * (Auto-Connect requirement: detected / connector available / configured /
 * authorized / validated / acquired are different states).
 */
export interface SourceAxes {
  readonly connectorAvailability: 'unknown' | 'supported' | 'unsupported';
  readonly connection: 'not_planned' | 'required' | 'configured' | 'validated' | 'failed';
  readonly authorization: 'not_requested' | 'required' | 'granted' | 'denied' | 'revoked';
  readonly acquisition: 'not_attempted' | 'succeeded' | 'partial' | 'failed';
  /** True when a previously reachable source stopped being reachable. */
  readonly unavailable: boolean;
}

export const INITIAL_AXES: SourceAxes = Object.freeze({
  connectorAvailability: 'unknown',
  connection: 'not_planned',
  authorization: 'not_requested',
  acquisition: 'not_attempted',
  unavailable: false,
});

/**
 * A single human-presentable summary derived from the axes. It is a VIEW:
 * never stored as the source of truth and never used to make a decision;
 * guards read the axes.
 */
export type SourceSummaryStatus =
  | 'detected'
  | 'supported'
  | 'connection_required'
  | 'authorization_required'
  | 'connected_and_validated'
  | 'acquisition_successful'
  | 'acquisition_partial'
  | 'unsupported_or_inaccessible'
  | 'failed_or_unavailable';

export function summarize(a: SourceAxes): SourceSummaryStatus {
  if (a.connection === 'failed' || a.acquisition === 'failed' || a.unavailable) return 'failed_or_unavailable';
  if (a.connectorAvailability === 'unsupported' || a.authorization === 'denied') return 'unsupported_or_inaccessible';
  if (a.acquisition === 'succeeded') return 'acquisition_successful';
  if (a.acquisition === 'partial') return 'acquisition_partial';
  if (a.connection === 'validated' && a.authorization === 'granted') return 'connected_and_validated';
  if (a.connection === 'configured' || a.connection === 'validated' || a.authorization === 'required' || a.authorization === 'revoked')
    return 'authorization_required';
  if (a.connection === 'required') return 'connection_required';
  if (a.connectorAvailability === 'supported') return 'supported';
  return 'detected';
}

export type SourceEvent =
  | 'connector_matched'
  | 'connector_missing'
  | 'connection_required'
  | 'connection_configured'
  | 'authorization_required'
  | 'authorization_granted'
  | 'authorization_denied'
  | 'authorization_revoked'
  | 'connection_validated'
  | 'connection_failed'
  | 'acquisition_succeeded'
  | 'acquisition_partial'
  | 'acquisition_failed'
  | 'source_unavailable'
  | 'source_reachable';

function illegal(event: SourceEvent, why: string): Result<never, DiscoveryError> {
  return err(discoveryError(DiscoveryErrorCode.INVALID_TRANSITION, `cannot apply "${event}": ${why}`, { event }));
}

/**
 * Pure transition function. The guards encode the trust ordering:
 * acquisition can only be recorded once a connection was validated AND
 * authorization is granted; validation requires a matched connector;
 * revocation discards the acquisition fact and flags that previously
 * acquired evidence must be purged (revocation boundary).
 */
export function transition(axes: SourceAxes, event: SourceEvent): Result<{ axes: SourceAxes; purgeRequired: boolean }, DiscoveryError> {
  const keep = (next: Partial<SourceAxes>, purgeRequired = false): Result<{ axes: SourceAxes; purgeRequired: boolean }, DiscoveryError> =>
    ok({ axes: Object.freeze({ ...axes, ...next }), purgeRequired });
  const matched = axes.connectorAvailability === 'supported';
  switch (event) {
    case 'connector_matched':
      return keep({ connectorAvailability: 'supported' });
    case 'connector_missing':
      return keep({ connectorAvailability: 'unsupported' });
    case 'connection_required':
      return matched ? keep({ connection: 'required' }) : illegal(event, 'no compatible connector has been matched');
    case 'connection_configured':
      return matched ? keep({ connection: 'configured' }) : illegal(event, 'no compatible connector has been matched');
    case 'authorization_required':
      return keep({ authorization: 'required' });
    case 'authorization_granted':
      return matched ? keep({ authorization: 'granted' }) : illegal(event, 'no compatible connector has been matched');
    case 'authorization_denied':
      return keep({ authorization: 'denied' });
    case 'authorization_revoked':
      return keep(
        { authorization: 'revoked', acquisition: 'not_attempted' },
        axes.acquisition === 'succeeded' || axes.acquisition === 'partial',
      );
    case 'connection_validated':
      if (!matched) return illegal(event, 'no compatible connector has been matched');
      if (axes.connection !== 'configured' && axes.connection !== 'validated')
        return illegal(event, 'the connection has not been configured');
      return keep({ connection: 'validated', unavailable: false });
    case 'connection_failed':
      return keep({ connection: 'failed' });
    case 'acquisition_succeeded':
    case 'acquisition_partial': {
      if (axes.authorization !== 'granted') return illegal(event, 'authorization has not been granted');
      if (axes.connection !== 'validated') return illegal(event, 'the connection has not been validated');
      return keep({ acquisition: event === 'acquisition_succeeded' ? 'succeeded' : 'partial' });
    }
    case 'acquisition_failed':
      return axes.authorization === 'granted' ? keep({ acquisition: 'failed' }) : illegal(event, 'authorization has not been granted');
    case 'source_unavailable':
      return keep({ unavailable: true });
    case 'source_reachable':
      return keep({ unavailable: false });
  }
}
