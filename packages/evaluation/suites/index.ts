import type { Suite } from '../src/index.js';
import { documentKindsSuite } from './document-kinds.js';
import { egressBoundarySuite } from './egress-boundary.js';
import { injectionCorpusSuite } from './injection-corpus.js';
import { intelligenceOracleSuite } from './intelligence-oracle.js';
import { realDocumentsSuite } from './real-documents.js';
import { tabularReadingSuite } from './tabular-reading.js';

/** Every suite of the harness. Adding one: write a Suite, add it here, give its measures proposed thresholds (evaluation/thresholds.json). */
export const SUITES: readonly Suite[] = [
  tabularReadingSuite,
  documentKindsSuite,
  egressBoundarySuite,
  intelligenceOracleSuite,
  injectionCorpusSuite,
  realDocumentsSuite,
];
