import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidenceLexiconRecord, FsKnowledgeStore, KnowledgeBase, loadEvidenceLexicon, type BkbEvidenceLexicon, type EvidenceLexiconEntryAttributes } from '@xo/knowledge-base';
import { FREIGHT_EVIDENCE_VOCABULARY } from './vocabulary.js';

const AUTHOR = { id: 'freight-desk-author', kind: 'user' } as const;
const REVIEWER = { id: 'freight-desk-reviewer', kind: 'user' } as const;

export interface SeededBkb {
  readonly kb: KnowledgeBase;
  readonly lexicon: BkbEvidenceLexicon;
}

/**
 * Puts a vocabulary into a Business Knowledge Base the way any knowledge enters it: proposed in a change set, approved by a
 * reviewer, active in the head state. Nothing reads it until it is approved. Returns the BKB and the lexicon loaded from it.
 * (A throw-away on-disk store keeps this self-contained for evaluations; a deployment points at its own BKB instead.)
 */
export async function seedEvidenceVocabulary(
  vocabulary: readonly EvidenceLexiconEntryAttributes[] = FREIGHT_EVIDENCE_VOCABULARY,
  dir?: string,
  tenant = 'freight-desk',
): Promise<SeededBkb> {
  const root = dir ?? (await mkdtemp(join(tmpdir(), 'xo-bkb-')));
  let tick = 0;
  const kb = new KnowledgeBase(await FsKnowledgeStore.open(root, tenant), () => new Date(Date.UTC(2026, 10, 1) + (tick += 1000)).toISOString());
  const sourceDigest = createHash('sha256').update(JSON.stringify(vocabulary)).digest('hex');
  const records = vocabulary.map((attrs) =>
    evidenceLexiconRecord(
      tenant,
      attrs,
      [{ sourceDigestSha256: sourceDigest, sourceName: 'evidence vocabulary (reviewed)', locator: { section: [attrs.concept] }, method: { kind: 'human', name: 'reviewer', version: '1' } }],
      '2026-11-01T00:00:00.000Z',
    ),
  );
  const cs = await kb.propose({ operations: records.map((record) => ({ op: 'add' as const, record })), origin: { kind: 'manual', ref: 'evidence-vocabulary' }, proposedBy: AUTHOR });
  if (cs === undefined) throw new Error('the evidence vocabulary produced no change');
  await kb.approve(cs.changeSetId, REVIEWER, 'vocabulary reviewed');
  return { kb, lexicon: await loadEvidenceLexicon(kb) };
}
