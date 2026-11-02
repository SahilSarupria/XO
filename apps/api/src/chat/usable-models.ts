import { ErrorCode, XoError } from '@xo/errors';
import { LOCAL_PROVIDER_IDS, type ModelChoice, type WorkspaceSettings } from '../settings/workspace-settings.js';
import type { ProviderFactory } from './model-provider.js';

/**
 * The workspace's selected models (primary, then fallback) that this deployment may actually use right now.
 * Shared by every AI experience in the API (Studio chat, customer intelligence chat) so air-gapped mode and
 * "server-side credentials only" are enforced identically. Throws a 412 that says what to change.
 */
export function usableModelChoices(settings: WorkspaceSettings, providerFor: ProviderFactory): readonly ModelChoice[] {
  const candidates = [settings.model.primary, settings.model.fallback].filter((c): c is ModelChoice => c !== null);
  if (candidates.length === 0) {
    throw new XoError(
      ErrorCode.PRECONDITION_FAILED,
      'no model is selected for this workspace; choose one in Settings → Models and runtime',
    );
  }
  const usable = candidates.filter(
    (c) => (!settings.airGapped || LOCAL_PROVIDER_IDS.has(c.provider)) && providerFor(c.provider) !== undefined,
  );
  if (usable.length === 0) {
    throw new XoError(
      ErrorCode.PRECONDITION_FAILED,
      settings.airGapped
        ? 'air-gapped mode is on and no selected model runs locally; choose a local model or turn air-gapped mode off'
        : `the selected model provider (${candidates.map((c) => c.provider).join(', ')}) has no server-side credentials configured`,
    );
  }
  return usable;
}
