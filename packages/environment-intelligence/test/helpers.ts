import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { MockClock } from '@xo/testing';
import {
  ConnectorRegistry,
  DevelopmentOperatorAuthorization,
  EnvironmentInventory,
  FailClosedAuthorization,
  LocalFilesystemConnector,
  type AuthorizationPort,
  type ConnectorContext,
  type DiscoveryDeps,
} from '../src/index.js';

export interface Sandbox {
  /** Real (symlink-resolved) path of the approved root inside a fresh temp dir. */
  readonly root: string;
  /** A sibling directory OUTSIDE the approved root. */
  readonly outside: string;
  readonly base: string;
}

export async function withSandbox(fn: (box: Sandbox) => Promise<void>): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'xo-ei-test-')));
  const root = join(base, 'approved');
  const outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  try {
    await fn({ root, outside, base });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

export async function put(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export function makeDeps(): DiscoveryDeps {
  const registry = new ConnectorRegistry();
  registry.register(new LocalFilesystemConnector());
  return { registry, inventory: new EnvironmentInventory() };
}

export function ctxFor(authorization: AuthorizationPort, clock: MockClock = new MockClock(), signal?: AbortSignal): ConnectorContext {
  return { clock, authorization, ...(signal !== undefined ? { signal } : {}) };
}

export function allowRoot(root: string, permissions: readonly string[] = ['filesystem.list']): AuthorizationPort {
  return new DevelopmentOperatorAuthorization(permissions.map((permission) => ({ permission, path: root })));
}

export const failClosed = (): AuthorizationPort => new FailClosedAuthorization();
