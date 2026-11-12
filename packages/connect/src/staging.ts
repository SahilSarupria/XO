import { ok, type Result } from '@xo/types';
import {
  capturingConnector,
  type AcquisitionOutcome,
  type AcquisitionRequest,
  type Connector,
  type ConnectorContext,
  type DiscoveryError,
  type DiscoveryScopeBase,
  type EvidenceStaging,
} from '@xo/environment-intelligence';

/**
 * Captures the evidence payloads of BOTH a sync and a plain acquisition into the staging store the knowledge derivation reads from.
 * EI's `capturingConnector` captures sync only. Acquisition is needed to re-hydrate knowledge after a restart: the model and the staged
 * payloads are memory-only, and an unchanged tree makes sync return nothing, so the payloads are re-read by acquisition. Evidence ids do
 * not depend on the operation that produced them, so re-read evidence has the same ids as what the journal already indexed.
 */
export function stagingConnector<TScope extends DiscoveryScopeBase>(inner: Connector<TScope>, staging: EvidenceStaging): Connector<TScope> {
  const base = capturingConnector(inner, staging);
  return {
    ...base,
    acquireContent: async (
      request: AcquisitionRequest & { readonly scope: TScope },
      ctx: ConnectorContext,
    ): Promise<Result<AcquisitionOutcome, DiscoveryError>> => {
      const out = await inner.acquireContent(request, ctx);
      if (out.ok) staging.stage(out.value.evidence);
      return out.ok ? ok(out.value) : out;
    },
  };
}
