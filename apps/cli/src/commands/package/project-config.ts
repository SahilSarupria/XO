import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompatibilityDeclaration, ComponentKind } from '@xo/types';
import { err, ok, type Result } from '@xo/types';

/**
 * `xo.project.json` is this CLI's own source-project convention — where
 * `xo init` scaffolds a package's identity/compatibility/component list
 * before it's ever built, and what `xo build` reads to assemble a
 * {@link ManifestBuilder} (via `@xo/package-sdk`'s public API — this file
 * does no hashing, validation, or archiving of its own). It is NOT part
 * of SPECIFICATION.md's `.xo` archive format; it's a working-directory
 * layout this CLI invented to have something for `init` to scaffold and
 * `build` to consume, the same way a `package.json` precedes an npm
 * tarball without itself being part of the tarball format.
 */
export interface ProjectComponentSpec {
  readonly kind: ComponentKind;
  /** Path relative to the project directory. Reused verbatim as the component's archive-relative path when built. */
  readonly path: string;
  readonly required: boolean;
}

export interface ProjectConfig {
  readonly formatVersion: string;
  readonly name: string;
  readonly version: string;
  readonly creatorDid: string;
  readonly compatibility: CompatibilityDeclaration;
  readonly components: readonly ProjectComponentSpec[];
  /** Path (relative to the project directory) to the XoMetadata JSON file. */
  readonly metadataPath: string;
}

export const PROJECT_CONFIG_FILENAME = 'xo.project.json';

export class ProjectConfigError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isProjectConfig(value: unknown): value is ProjectConfig {
  if (!isRecord(value)) return false;
  if (typeof value.formatVersion !== 'string') return false;
  if (typeof value.name !== 'string' || value.name.length === 0) return false;
  if (typeof value.version !== 'string') return false;
  if (typeof value.creatorDid !== 'string' || value.creatorDid.length === 0) return false;
  if (!isRecord(value.compatibility)) return false;
  if (typeof value.metadataPath !== 'string') return false;
  if (!Array.isArray(value.components)) return false;
  return value.components.every(
    (c) => isRecord(c) && typeof c.kind === 'string' && typeof c.path === 'string' && typeof c.required === 'boolean',
  );
}

/** Reads and structurally validates `<dir>/xo.project.json`. Returns a `Result` — a missing or malformed project file is an expected, actionable outcome for a CLI command to report, not a crash. */
export async function readProjectConfig(dir: string): Promise<Result<ProjectConfig, ProjectConfigError>> {
  const path = join(dir, PROJECT_CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    return err(new ProjectConfigError(`Could not read "${path}": ${(cause as Error).message}. Run "xo init ${dir}" first?`));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return err(new ProjectConfigError(`"${path}" is not valid JSON: ${(cause as Error).message}`));
  }

  if (!isProjectConfig(parsed)) {
    return err(
      new ProjectConfigError(
        `"${path}" does not match the expected xo.project.json shape (formatVersion, name, version, creatorDid, compatibility, components[], metadataPath)`,
      ),
    );
  }
  return ok(parsed);
}
