import { ErrorCode, XoError } from '@xo/errors';
import { SUPPORTED_PROVIDER_IDS } from '../routes/runtime/provider-factory.js';
import { isKnownRegion } from '../workspace/regions.js';

/**
 * Per-workspace configuration, one JSON document with an optimistic-concurrency `revision`.
 *
 * Every field here is either ENFORCED by this server (and says where), or it is rejected at save time — a setting the
 * server cannot honor is never silently stored as if it were in effect. `describeEffect()` in settings-routes reports
 * which is which, per section, so a UI can show "enforced" vs "declared" truthfully.
 */

export const RUNTIME_LOCATIONS = ['this_computer', 'private_server', 'cloud'] as const;
export type RuntimeLocation = (typeof RUNTIME_LOCATIONS)[number];

/** Providers that run on the caller's own machine. Everything else sends prompts off-box and is refused in air-gapped mode. */
export const LOCAL_PROVIDER_IDS: ReadonlySet<string> = new Set(['ollama']);

export interface ModelChoice {
  readonly provider: string;
  readonly model: string;
}

export interface WorkspaceSettings {
  readonly revision: number;
  readonly runtime: { readonly location: RuntimeLocation };
  readonly model: { readonly primary: ModelChoice | null; readonly fallback: ModelChoice | null };
  /** Blocks every outbound network call made on this workspace's behalf (URL import, off-box model providers). */
  readonly airGapped: boolean;
  readonly trust: {
    /** Registry publish and XO install refuse packages that carry no signatures. */
    readonly requireSignedPackages: boolean;
  };
  readonly notifications: {
    readonly onEscalation: boolean;
    readonly onRunFailure: boolean;
    readonly onWorkflowComplete: boolean;
  };
  readonly updatedAt?: string;
  readonly updatedBy?: string;
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  revision: 0,
  runtime: { location: 'this_computer' },
  model: { primary: null, fallback: null },
  airGapped: false,
  trust: { requireSignedPackages: false },
  notifications: { onEscalation: true, onRunFailure: true, onWorkflowComplete: false },
};

function invalid(message: string): never {
  throw new XoError(ErrorCode.INVALID_ARGUMENT, message);
}

function obj(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`"${where}" must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknown(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(o)) if (!allowed.includes(key)) invalid(`unknown field "${key}" in ${where}`);
}

function bool(o: Record<string, unknown>, key: string, where: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') invalid(`"${where}.${key}" must be a boolean`);
  return v;
}

function parseModelChoice(value: unknown, where: string): ModelChoice | null {
  if (value === null) return null;
  const o = obj(value, where);
  rejectUnknown(o, ['provider', 'model'], where);
  const provider = o['provider'];
  const model = o['model'];
  if (typeof provider !== 'string' || !(SUPPORTED_PROVIDER_IDS as readonly string[]).includes(provider)) {
    invalid(`"${where}.provider" must be one of: ${SUPPORTED_PROVIDER_IDS.join(', ')}`);
  }
  if (typeof model !== 'string' || model.trim().length === 0 || model.length > 120 || /[\s]/.test(model)) {
    invalid(`"${where}.model" must be a non-empty model id (no whitespace, at most 120 characters)`);
  }
  return { provider, model: model.trim() };
}

export interface SettingsPatch {
  readonly expectedRevision?: number;
  readonly runtime?: { readonly location: RuntimeLocation };
  readonly model?: { readonly primary?: ModelChoice | null; readonly fallback?: ModelChoice | null };
  readonly airGapped?: boolean;
  readonly region?: string;
  readonly trust?: { readonly requireSignedPackages?: boolean };
  readonly notifications?: { readonly onEscalation?: boolean; readonly onRunFailure?: boolean; readonly onWorkflowComplete?: boolean };
}

/** Parses an untrusted PUT body. Unknown fields anywhere are rejected, not ignored. */
export function parseSettingsPatch(body: unknown, availableLocations: readonly RuntimeLocation[]): SettingsPatch {
  const o = obj(body, 'body');
  rejectUnknown(o, ['expectedRevision', 'runtime', 'model', 'airGapped', 'region', 'trust', 'notifications'], 'settings');
  const patch: { -readonly [K in keyof SettingsPatch]: SettingsPatch[K] } = {};

  if (o['expectedRevision'] !== undefined) {
    if (typeof o['expectedRevision'] !== 'number' || !Number.isInteger(o['expectedRevision']) || o['expectedRevision'] < 0) {
      invalid('"expectedRevision" must be a non-negative integer');
    }
    patch.expectedRevision = o['expectedRevision'];
  }
  if (o['runtime'] !== undefined) {
    const r = obj(o['runtime'], 'runtime');
    rejectUnknown(r, ['location'], 'runtime');
    const location = r['location'];
    if (typeof location !== 'string' || !(RUNTIME_LOCATIONS as readonly string[]).includes(location)) {
      invalid(`"runtime.location" must be one of: ${RUNTIME_LOCATIONS.join(', ')}`);
    }
    if (!availableLocations.includes(location as RuntimeLocation)) {
      throw new XoError(
        ErrorCode.PRECONDITION_FAILED,
        `runtime location "${location}" is not available on this deployment (available: ${availableLocations.join(', ')})`,
      );
    }
    patch.runtime = { location: location as RuntimeLocation };
  }
  if (o['model'] !== undefined) {
    const m = obj(o['model'], 'model');
    rejectUnknown(m, ['primary', 'fallback'], 'model');
    patch.model = {
      ...(m['primary'] !== undefined ? { primary: parseModelChoice(m['primary'], 'model.primary') } : {}),
      ...(m['fallback'] !== undefined ? { fallback: parseModelChoice(m['fallback'], 'model.fallback') } : {}),
    };
  }
  const air = bool(o, 'airGapped', 'settings');
  if (air !== undefined) patch.airGapped = air;
  if (o['region'] !== undefined) {
    if (!isKnownRegion(o['region'])) invalid('"region" must be one of the ids from GET /regions');
    patch.region = o['region'];
  }
  if (o['trust'] !== undefined) {
    const t = obj(o['trust'], 'trust');
    rejectUnknown(t, ['requireSignedPackages'], 'trust');
    const req = bool(t, 'requireSignedPackages', 'trust');
    patch.trust = req !== undefined ? { requireSignedPackages: req } : {};
  }
  if (o['notifications'] !== undefined) {
    const n = obj(o['notifications'], 'notifications');
    rejectUnknown(n, ['onEscalation', 'onRunFailure', 'onWorkflowComplete'], 'notifications');
    const a = bool(n, 'onEscalation', 'notifications');
    const b = bool(n, 'onRunFailure', 'notifications');
    const c = bool(n, 'onWorkflowComplete', 'notifications');
    patch.notifications = {
      ...(a !== undefined ? { onEscalation: a } : {}),
      ...(b !== undefined ? { onRunFailure: b } : {}),
      ...(c !== undefined ? { onWorkflowComplete: c } : {}),
    };
  }
  return patch;
}

/** Applies a validated patch and re-checks the cross-field rules on the RESULT (so order of fields in the body never matters). */
export function applySettingsPatch(current: WorkspaceSettings, patch: SettingsPatch, updatedBy: string, now: Date): WorkspaceSettings {
  const next: WorkspaceSettings = {
    ...current,
    revision: current.revision + 1,
    runtime: patch.runtime ?? current.runtime,
    model: {
      primary: patch.model?.primary !== undefined ? patch.model.primary : current.model.primary,
      fallback: patch.model?.fallback !== undefined ? patch.model.fallback : current.model.fallback,
    },
    airGapped: patch.airGapped ?? current.airGapped,
    trust: { requireSignedPackages: patch.trust?.requireSignedPackages ?? current.trust.requireSignedPackages },
    notifications: {
      onEscalation: patch.notifications?.onEscalation ?? current.notifications.onEscalation,
      onRunFailure: patch.notifications?.onRunFailure ?? current.notifications.onRunFailure,
      onWorkflowComplete: patch.notifications?.onWorkflowComplete ?? current.notifications.onWorkflowComplete,
    },
    updatedAt: now.toISOString(),
    updatedBy,
  };
  if (next.airGapped) {
    for (const [slot, choice] of [
      ['primary', next.model.primary],
      ['fallback', next.model.fallback],
    ] as const) {
      if (choice !== null && !LOCAL_PROVIDER_IDS.has(choice.provider)) {
        throw new XoError(
          ErrorCode.PRECONDITION_FAILED,
          `air-gapped mode forbids the off-box provider "${choice.provider}" as the ${slot} model; choose a local provider (${[...LOCAL_PROVIDER_IDS].join(', ')}) or turn air-gapped mode off`,
        );
      }
    }
  }
  return next;
}
