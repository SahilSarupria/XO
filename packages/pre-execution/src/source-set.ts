/**
 * PX-1 (ADR 0029 decision 1): source versions and source sets.
 *
 * A source VERSION is its bytes: identified by their SHA-256. A source RECORD is one upload or import event (its own id,
 * origin, uploader and time); two uploads of the same bytes are two records sharing one version, and neither is erased.
 *
 * A source SET is the ordered list of versions a compilation ran on. Its id is derived from its canonical content, so the
 * same set has the same id on every surface, and any changed byte, added or removed source, or reordering gives a new id.
 * Order is significant because the compiler reads sources in order (cross-document precedence, merge order).
 */
import { canonicalJson, digestOf, type Digest } from './canonical.js';

export const SOURCE_SET_SCHEMA = 'xo.source-set.v1';

/** `instruction`: a prompt an author wrote (what they want, never evidence). */
export type SourceRole = 'primary' | 'attachment' | 'supporting' | 'instruction';

export interface SourceSetEntry {
  /** The source record the bytes were read from (an upload or import event). Not part of the set's identity. */
  readonly sourceId: string;
  /** Lowercase hex SHA-256 of the exact bytes compiled. */
  readonly digestSha256: string;
  /** File name as given (display, and the compiler's source path). Part of the identity: it is the source path compiled. */
  readonly name: string;
  readonly byteSize: number;
  readonly role: SourceRole;
  /** For an email attachment, the digest of the email it came from. */
  readonly parentDigestSha256?: string;
}

export interface SourceSetManifest {
  readonly schema: typeof SOURCE_SET_SCHEMA;
  /** `ss_` + the first 24 hex characters of the identity digest. */
  readonly sourceSetId: string;
  /** Digest over the schema and each entry's `{digestSha256, name, role, parentDigestSha256}`, in order. */
  readonly digest: Digest;
  readonly entries: readonly SourceSetEntry[];
}

const HEX64 = /^[0-9a-f]{64}$/;

function identityOf(entries: readonly SourceSetEntry[]): unknown {
  return {
    schema: SOURCE_SET_SCHEMA,
    entries: entries.map((e) => ({
      digestSha256: e.digestSha256,
      name: e.name,
      role: e.role,
      ...(e.parentDigestSha256 !== undefined ? { parentDigestSha256: e.parentDigestSha256 } : {}),
    })),
  };
}

/** Builds the manifest for `entries` in the given order. Throws on an empty set or a malformed digest. */
export function buildSourceSet(entries: readonly SourceSetEntry[]): SourceSetManifest {
  if (entries.length === 0) throw new Error('a source set needs at least one source');
  for (const e of entries) {
    if (!HEX64.test(e.digestSha256)) throw new Error(`source "${e.name}": digestSha256 must be 64 lowercase hex characters`);
    if (e.parentDigestSha256 !== undefined && !HEX64.test(e.parentDigestSha256))
      throw new Error(`source "${e.name}": parentDigestSha256 must be 64 lowercase hex characters`);
  }
  const digest = digestOf(identityOf(entries));
  return { schema: SOURCE_SET_SCHEMA, sourceSetId: `ss_${digest.slice('sha256:'.length, 'sha256:'.length + 24)}`, digest, entries };
}

/** Recomputes the identity of `manifest` and reports whether it matches what the manifest claims. */
export function verifySourceSet(manifest: SourceSetManifest): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (manifest.schema !== SOURCE_SET_SCHEMA) return { ok: false, reason: `unknown source-set schema "${String(manifest.schema)}"` };
  let rebuilt: SourceSetManifest;
  try {
    rebuilt = buildSourceSet(manifest.entries);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (rebuilt.digest !== manifest.digest) return { ok: false, reason: 'the source-set digest does not match its entries' };
  if (rebuilt.sourceSetId !== manifest.sourceSetId) return { ok: false, reason: 'the source-set id does not match its digest' };
  return { ok: true };
}

/** The canonical text the digest is computed over (for audit and for other implementations). */
export function sourceSetIdentityText(entries: readonly SourceSetEntry[]): string {
  return canonicalJson(identityOf(entries));
}
