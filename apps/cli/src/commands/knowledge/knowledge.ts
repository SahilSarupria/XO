/**
 * PX-4 — `xo knowledge`: the Business Knowledge Base from the command line, over the same `@xo/knowledge-base` service and
 * the same XOIR→BKB adapter the API uses, on a local store (`--kb <dir>`, default `.xo/knowledge`; tenant `--tenant`,
 * default `local`). Proposing never changes the active state; only `approve` does.
 */
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import {
  FsKnowledgeStore,
  KnowledgeBase,
  KnowledgeError,
  reconcileXoirGraph,
  type Actor,
  type PackArtifact,
  type XoirGraphView,
} from '@xo/knowledge-base';
import { compileSourceSet, defaultCompileConfiguration } from '@xo/pre-execution';
import { toJson } from '@xo/xoir';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';
import { collectSources } from '../compiler/source-collection.js';

export interface KnowledgeOptions {
  readonly action: string;
  readonly args: readonly string[];
  readonly kbDir: string;
  readonly tenant: string;
  readonly json: boolean;
  readonly reason?: string;
  readonly state?: string;
}

export const KNOWLEDGE_USAGE =
  'xo knowledge <propose <source>...|change-sets|show <cs>|approve <cs> --reason <r>|reject <cs> --reason <r>|state|verify [<state>]|search <text>|conflicts|install-pack <pack.json>|packs> [--kb <dir>] [--tenant <id>] [--state <id>] [--json]';

function localActor(): Actor {
  let name = 'local-user';
  try {
    name = userInfo().username || name;
  } catch {
    // no user database entry (containers): keep the default
  }
  return { id: `local:${name}`, kind: 'human' };
}

const out = (json: boolean, value: unknown, lines: () => readonly string[]): CommandResult =>
  json ? ok([JSON.stringify(value, null, 2)]) : ok(lines());

export async function knowledgeCommand(o: KnowledgeOptions): Promise<CommandResult> {
  let kb: KnowledgeBase;
  try {
    kb = new KnowledgeBase(await FsKnowledgeStore.open(o.kbDir, o.tenant));
  } catch (cause) {
    return failWith(`could not open the knowledge base at ${o.kbDir}: ${(cause as Error).message}`);
  }
  const actor = localActor();
  try {
    switch (o.action) {
      case 'propose':
        return await propose(kb, o, actor);
      case 'change-sets': {
        const all = await kb.changeSets();
        return out(o.json, all, () =>
          all.length === 0
            ? ['no change sets']
            : all.map(
                (c) =>
                  `${c.changeSetId}  ${c.status.padEnd(8)}  ${c.operations.length} op(s)  ${c.findings.filter((f) => f.severity === 'error').length} error(s)  from ${c.origin.kind}${c.origin.ref !== undefined ? ` ${c.origin.ref}` : ''}`,
              ),
        );
      }
      case 'show': {
        const cs = await kb.changeSet(required(o.args[0], 'a change set id'));
        return out(o.json, cs, () => [
          `${cs.changeSetId}  ${cs.status}  base ${cs.baseStateId}`,
          ...cs.operations.map(
            (op) => `  ${op.op} ${'record' in op ? `${op.record.kind} ${op.record.id}` : 'by' in op ? `${op.recordId} → ${op.by.id}` : ''}`,
          ),
          ...cs.findings.map((f) => `  [${f.severity}] ${f.code}: ${f.message}`),
          ...(cs.report !== undefined ? [`  report: ${reportLine(cs.report)}`] : []),
        ]);
      }
      case 'approve': {
        const state = await kb.approve(required(o.args[0], 'a change set id'), actor, required(o.reason, '--reason'));
        return out(o.json, state, () => [
          `approved; the head is now ${state.stateId} (${state.entries.length} record(s), ${state.conflicts.length} conflict(s))`,
        ]);
      }
      case 'reject': {
        const id = required(o.args[0], 'a change set id');
        await kb.reject(id, actor, required(o.reason, '--reason'));
        return out(o.json, { changeSetId: id, status: 'rejected' }, () => [`rejected ${id}`]);
      }
      case 'state': {
        const s = o.state !== undefined ? await kb.state(o.state) : await kb.head();
        const count = (l: string): number => s.entries.filter((e) => e.lifecycle === l).length;
        return out(o.json, s, () => [
          `${s.stateId}  ${s.digest}`,
          `  ${count('active')} active, ${count('superseded')} superseded, ${count('retired')} retired, ${s.conflicts.length} conflict(s)`,
          `  packs: ${s.packBindings.map((b) => `${b.namespace}@${b.version}`).join(', ') || 'none'}`,
          `  parent: ${s.parentStateId ?? 'none'}`,
        ]);
      }
      case 'verify': {
        const id = o.args[0] ?? o.state ?? (await kb.head()).stateId;
        const findings = await kb.verifyState(id);
        const result = out(o.json, { stateId: id, verified: findings.length === 0, findings }, () =>
          findings.length === 0 ? [`${id} verifies`] : [`${id} does NOT verify:`, ...findings.map((f) => `  [${f.code}] ${f.message}`)],
        );
        return findings.length === 0 ? result : { ...result, exitCode: 1 };
      }
      case 'search': {
        const text = o.args.join(' ');
        if (text.trim() === '') return failWith('xo knowledge search <text>');
        const stateId = o.state ?? (await kb.head()).stateId;
        const hits = await kb.search(stateId, text);
        return out(o.json, { stateId, hits }, () =>
          hits.length === 0
            ? [`no matches in ${stateId}`]
            : hits.map(
                (h) =>
                  `${h.score.toFixed(3)}  ${h.recordId}  ${h.type}  ${h.text.slice(0, 100)}  [${h.evidence.map((e) => e.sourceName).join(', ')}]`,
              ),
        );
      }
      case 'conflicts': {
        const s = o.state !== undefined ? await kb.state(o.state) : await kb.head();
        return out(o.json, s.conflicts, () =>
          s.conflicts.length === 0
            ? ['no conflicts']
            : s.conflicts.map(
                (c) => `${c.id}  ${c.status}  ${c.claims.join(' vs ')}${c.prevailing !== undefined ? `  prevailing ${c.prevailing}` : ''}`,
              ),
        );
      }
      case 'install-pack': {
        const pack = JSON.parse(await readFile(required(o.args[0], 'a pack file'), 'utf8')) as PackArtifact;
        await kb.installPack(pack, actor);
        return ok([`installed ${pack.manifest.packId}@${pack.manifest.version} for namespace "${pack.manifest.namespace}"`]);
      }
      case 'packs': {
        const b = (await kb.packs()).bindings();
        return out(o.json, b, () =>
          b.length === 0 ? ['no packs installed'] : b.map((x) => `${x.namespace}  ${x.packId}@${x.version}  ${x.digest}`),
        );
      }
      default:
        return failWith(KNOWLEDGE_USAGE);
    }
  } catch (cause) {
    if (cause instanceof KnowledgeError) return failWith(`[${cause.code}] ${cause.message}`);
    return failWith((cause as Error).message);
  }
}

function required(v: string | undefined, what: string): string {
  if (v === undefined || v.trim() === '') throw new Error(`missing ${what}`);
  return v;
}

function reportLine(r: NonNullable<Awaited<ReturnType<KnowledgeBase['changeSet']>>['report']>): string {
  return `${r.accepted.length} accepted, ${r.unchanged.length} unchanged, ${r.updated.length} updated, ${r.conflicting.length} conflicting, ${r.unresolved.length} unresolved, ${r.rejected.length} rejected, ${r.unsupported.length} unsupported`;
}

async function propose(kb: KnowledgeBase, o: KnowledgeOptions, actor: Actor): Promise<CommandResult> {
  if (o.args.length === 0) return failWith('xo knowledge propose <source>...');
  const collected = await collectSources(o.args);
  try {
    const compiled = await compileSourceSet(
      collected.inputs.map((input, i) => ({ entry: collected.entries[i]!, input })) as Parameters<typeof compileSourceSet>[0],
      defaultCompileConfiguration({}),
    );
    if (!compiled.ok) return failWith(`[${compiled.error.code}] ${compiled.error.message}`);
    const { artifact, result } = compiled.value;
    const byName = new Map(artifact.sourceSet.entries.map((e) => [e.name, e] as const));
    const sources = new Map<string, { name: string; digestSha256: string }>();
    for (const s of result.sources) {
      const entry = byName.get(s.sourcePath);
      if (entry !== undefined) sources.set(s.sourceId, { name: entry.name, digestSha256: entry.digestSha256 });
    }
    const { changeSet, report } = await reconcileXoirGraph(kb, toJson(result.graph) as unknown as XoirGraphView, {
      sources,
      origin: {
        kind: 'xoir-reconciliation',
        sourceSetId: artifact.sourceSet.sourceSetId,
        compilationArtifactDigest: artifact.digest,
        xoirGraphHash: artifact.graph.contentHash,
      },
      proposedBy: actor,
      recordedAt: new Date().toISOString(),
    });
    return out(o.json, { changeSet: changeSet ?? null, report }, () => [
      changeSet === undefined
        ? 'nothing new: every record is already in the head state'
        : `proposed ${changeSet.changeSetId} against ${changeSet.baseStateId} (${changeSet.operations.length} operation(s)); approve it with: xo knowledge approve ${changeSet.changeSetId} --reason "<why>"`,
      `  ${reportLine(report)}`,
      ...report.unresolved.map((u) => `  unresolved ${u.ref}: ${u.reason}`),
      ...(changeSet?.findings ?? []).map((f) => `  [${f.severity}] ${f.code}: ${f.message}`),
    ]);
  } finally {
    await collected.cleanup();
  }
}
