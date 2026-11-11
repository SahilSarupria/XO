import type { CapabilityInputSchema } from '@xo/types';
import type { ExternalToolAdapter } from '@xo/adapters';
import { createDurableExternalToolWiring, type ExternalToolWiring } from '@xo/runtime';
import { LocalFsBlobStore } from '@xo/storage';
import type { ApiConfig } from './config.js';

/**
 * The supported way for an EMBEDDING host (code that supplies adapters; the shipped entrypoint supplies none) to turn the server config
 * into external-tool wiring. The evidence location comes from `ApiConfig.externalEffectsDir` (`XO_EXTERNAL_EFFECTS_DIR`) and nowhere else;
 * if it is unset this THROWS before anything can dispatch, and the result is always backed by the durable `BlobDispatchLedger`.
 * Guarantee scope: `LocalFsBlobStore` — atomic only across processes on one filesystem (see the M4 status doc).
 */
export function createConfiguredExternalToolWiring(
  config: Pick<ApiConfig, 'externalEffectsDir'>,
  options: {
    readonly adapters: ReadonlyMap<string, ExternalToolAdapter>;
    readonly inputSchemas: ReadonlyMap<string, CapabilityInputSchema>;
  },
): ExternalToolWiring {
  if (config.externalEffectsDir === undefined) {
    throw new Error(
      'external tools require XO_EXTERNAL_EFFECTS_DIR (a persistent evidence directory); none is configured, so none are enabled',
    );
  }
  return createDurableExternalToolWiring({ ...options, evidenceStore: new LocalFsBlobStore(config.externalEffectsDir) });
}
