import { applyLexicon } from '@xo/capability-layer';
import { FREIGHT_TREE, seedEvidenceVocabulary } from '../src/index.js';

/** The freight vocabulary, loaded from a real (throw-away) Business Knowledge Base after review. */
export const { kb: BKB, lexicon: LEXICON } = await seedEvidenceVocabulary();
/** The hand-built tree with the BKB vocabulary applied: what a grounded layer actually checks against. */
export const TREE = applyLexicon(FREIGHT_TREE, LEXICON);
