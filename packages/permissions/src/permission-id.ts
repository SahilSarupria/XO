import { brand, err, ok, type Brand, type Result } from '@xo/types';
import { isPermissionDomain, type PermissionDomain } from './domain.js';

/**
 * A strongly typed, validated permission identifier — `"filesystem.read"`,
 * `"ai.external-provider"`, etc. Branded (see `@xo/types`' `Brand`) so a
 * bare `string` can never be passed where a `PermissionId` is expected
 * without going through {@link PermissionId} or {@link parsePermissionId},
 * both of which validate the format. This is what §4 means by "a strongly
 * typed representation rather than scattering string literals" and half of
 * what §18 means by "no permission string spoofing" — the other half is
 * {@link isPermissionDomain}'s closed domain set.
 */
export type PermissionId = Brand<string, 'PermissionId'>;

/**
 * `domain.action`, where `domain` is one of {@link PERMISSION_DOMAINS} and
 * `action` is one or more lowercase, hyphen-separated words (e.g. `read`,
 * `external-provider`). Deliberately strict: no uppercase, no underscores,
 * no leading/trailing/duplicate hyphens or dots, no whitespace — a format a
 * malicious or buggy manifest can't fuzz its way through.
 */
const PERMISSION_ID_PATTERN = /^([a-z][a-z0-9]*)\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

export interface ParsedPermissionId {
  readonly id: PermissionId;
  readonly domain: PermissionDomain;
  readonly action: string;
}

/**
 * Validates and parses `value` into a {@link ParsedPermissionId}, without
 * throwing — the non-throwing counterpart to {@link PermissionId}, for
 * call sites handling untrusted input (a manifest read off disk, a request
 * a package constructed) where an invalid id is an expected, recoverable
 * failure mode rather than a programmer error. Per §18's "fail closed":
 * callers that get `err` here must treat the request as invalid, never as
 * implicitly `global`/wildcard.
 */
export function parsePermissionId(value: string): Result<ParsedPermissionId, string> {
  const match = PERMISSION_ID_PATTERN.exec(value);
  if (!match) {
    return err(`"${value}" is not a valid permission id (expected "domain.action", e.g. "filesystem.read")`);
  }
  const [, domain, action] = match;
  if (domain === undefined || action === undefined) {
    return err(`"${value}" is not a valid permission id`);
  }
  if (!isPermissionDomain(domain)) {
    return err(`"${value}" has unrecognized domain "${domain}" — must be one of the registered permission domains`);
  }
  return ok({ id: brand(value), domain, action });
}

/**
 * Validates and brands `value` as a {@link PermissionId}, throwing on an
 * invalid format — mirrors `@xo/types`' `ContentHash` constructor
 * (validate-then-brand, throw on malformed input). Use this for permission
 * ids a programmer is writing as a literal (e.g. building a policy rule in
 * code); use {@link parsePermissionId} for untrusted/external input.
 */
export function PermissionId(value: string): PermissionId {
  const parsed = parsePermissionId(value);
  if (!parsed.ok) throw new TypeError(parsed.error);
  return parsed.value.id;
}

export function permissionDomain(id: PermissionId): PermissionDomain {
  const parsed = parsePermissionId(id);
  if (!parsed.ok) throw new TypeError(parsed.error); // unreachable for a well-formed PermissionId
  return parsed.value.domain;
}

/**
 * The example permission ids §4 lists, pre-validated and branded, so
 * callers get autocomplete and a compile error on a typo instead of a
 * runtime one. Not the full universe of permissions a package may declare
 * — domains are closed (see `domain.ts`) but actions within a domain are
 * not, so a package/host may mint additional `PermissionId`s in an
 * existing domain via {@link PermissionId} without touching this file.
 */
export const Permissions = {
  filesystem: {
    read: PermissionId('filesystem.read'),
    write: PermissionId('filesystem.write'),
    delete: PermissionId('filesystem.delete'),
  },
  network: {
    connect: PermissionId('network.connect'),
    listen: PermissionId('network.listen'),
  },
  process: {
    spawn: PermissionId('process.spawn'),
    execute: PermissionId('process.execute'),
  },
  environment: {
    read: PermissionId('environment.read'),
  },
  secrets: {
    read: PermissionId('secrets.read'),
    write: PermissionId('secrets.write'),
  },
  clipboard: {
    read: PermissionId('clipboard.read'),
    write: PermissionId('clipboard.write'),
  },
  device: {
    camera: PermissionId('device.camera'),
    microphone: PermissionId('device.microphone'),
  },
  ai: {
    inference: PermissionId('ai.inference'),
    externalProvider: PermissionId('ai.external-provider'),
  },
  data: {
    read: PermissionId('data.read'),
    write: PermissionId('data.write'),
  },
  package: {
    install: PermissionId('package.install'),
    publish: PermissionId('package.publish'),
  },
  runtime: {
    execute: PermissionId('runtime.execute'),
    workflow: PermissionId('runtime.workflow'),
  },
} as const;
