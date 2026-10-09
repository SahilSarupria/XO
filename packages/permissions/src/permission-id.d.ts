import { type Brand, type Result } from '@xo/types';
import { type PermissionDomain } from './domain.js';
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
export declare function parsePermissionId(value: string): Result<ParsedPermissionId, string>;
/**
 * Validates and brands `value` as a {@link PermissionId}, throwing on an
 * invalid format — mirrors `@xo/types`' `ContentHash` constructor
 * (validate-then-brand, throw on malformed input). Use this for permission
 * ids a programmer is writing as a literal (e.g. building a policy rule in
 * code); use {@link parsePermissionId} for untrusted/external input.
 */
export declare function PermissionId(value: string): PermissionId;
export declare function permissionDomain(id: PermissionId): PermissionDomain;
/**
 * The example permission ids §4 lists, pre-validated and branded, so
 * callers get autocomplete and a compile error on a typo instead of a
 * runtime one. Not the full universe of permissions a package may declare
 * — domains are closed (see `domain.ts`) but actions within a domain are
 * not, so a package/host may mint additional `PermissionId`s in an
 * existing domain via {@link PermissionId} without touching this file.
 */
export declare const Permissions: {
    readonly filesystem: {
        readonly read: PermissionId;
        readonly write: PermissionId;
        readonly delete: PermissionId;
    };
    readonly network: {
        readonly connect: PermissionId;
        readonly listen: PermissionId;
    };
    readonly process: {
        readonly spawn: PermissionId;
        readonly execute: PermissionId;
    };
    readonly environment: {
        readonly read: PermissionId;
    };
    readonly secrets: {
        readonly read: PermissionId;
        readonly write: PermissionId;
    };
    readonly clipboard: {
        readonly read: PermissionId;
        readonly write: PermissionId;
    };
    readonly device: {
        readonly camera: PermissionId;
        readonly microphone: PermissionId;
    };
    readonly ai: {
        readonly inference: PermissionId;
        readonly externalProvider: PermissionId;
    };
    readonly data: {
        readonly read: PermissionId;
        readonly write: PermissionId;
    };
    readonly package: {
        readonly install: PermissionId;
        readonly publish: PermissionId;
    };
    readonly runtime: {
        readonly execute: PermissionId;
        readonly workflow: PermissionId;
    };
};
//# sourceMappingURL=permission-id.d.ts.map