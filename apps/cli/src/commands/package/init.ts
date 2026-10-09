import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompatibilityDeclaration, XoMetadata } from '@xo/types';
import type { CommandResult } from '../../command-result.js';
import { ok } from '../../command-result.js';
import { PROJECT_CONFIG_FILENAME, type ProjectConfig } from './project-config.js';

export interface InitOptions {
  readonly dir: string;
  readonly name: string;
  readonly creatorDid: string;
  readonly version?: string;
  readonly formatVersion?: string;
}

const DEFAULT_COMPATIBILITY: CompatibilityDeclaration = {
  modelFamilies: [
    { family: 'claude', minCapability: ['chat', 'tool_use'], consumes: ['knowledge_graph', 'safety_rules', 'benchmark_suite'] },
    { family: 'generic', minCapability: ['chat'], consumes: ['knowledge_graph'] },
  ],
  fallbackPolicy: 'degrade_gracefully',
};

/**
 * Scaffolds a new package project on disk: `xo.project.json`, a
 * `metadata.json` stub, and one stub file for each of the three
 * components every package needs to pass `PackageValidator` (a
 * `knowledge_graph` plus the two marketplace-mandatory components,
 * `safety_rules` and `benchmark_suite` — see
 * `PackageValidator.validateRequiredComponents`). Writes files only; all
 * hashing/building/validation happens later in `xo build`, via
 * `@xo/package-sdk`.
 */
export async function initCommand(options: InitOptions): Promise<CommandResult> {
  const version = options.version ?? '0.1.0';
  const formatVersion = options.formatVersion ?? '1.0';

  const config: ProjectConfig = {
    formatVersion,
    name: options.name,
    version,
    creatorDid: options.creatorDid,
    compatibility: DEFAULT_COMPATIBILITY,
    components: [
      { kind: 'knowledge_graph', path: 'knowledge/graph.json', required: false },
      { kind: 'safety_rules', path: 'safety/rules.json', required: true },
      { kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', required: true },
    ],
    metadataPath: 'metadata.json',
  };

  const metadata: XoMetadata = {
    domain: options.name,
    description: `TODO: describe what "${options.name}" does.`,
    scope: ['TODO: list what this package covers'],
    limitations: ['TODO: list what this package does NOT cover'],
    tags: [],
  };

  await mkdir(join(options.dir, 'knowledge'), { recursive: true });
  await mkdir(join(options.dir, 'safety'), { recursive: true });
  await mkdir(join(options.dir, 'evaluation'), { recursive: true });

  await writeFile(join(options.dir, PROJECT_CONFIG_FILENAME), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await writeFile(join(options.dir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  await writeFile(join(options.dir, 'knowledge/graph.json'), `${JSON.stringify({ nodes: [], edges: [] }, null, 2)}\n`, 'utf8');
  await writeFile(join(options.dir, 'safety/rules.json'), `${JSON.stringify({ rules: [] }, null, 2)}\n`, 'utf8');
  await writeFile(join(options.dir, 'evaluation/benchmark_suite.json'), `${JSON.stringify({ categories: [] }, null, 2)}\n`, 'utf8');

  return ok([
    `Initialized a new XO package project in ${options.dir}`,
    `  ${PROJECT_CONFIG_FILENAME}          identity, compatibility, and component list`,
    '  metadata.json                domain, description, scope, limitations',
    '  knowledge/graph.json         knowledge_graph component stub',
    '  safety/rules.json            safety_rules component stub (required)',
    '  evaluation/benchmark_suite.json  benchmark_suite component stub (required)',
    '',
    `Fill in the TODOs, then run: xo build ${options.dir}`,
  ]);
}
