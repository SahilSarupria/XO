// M0b candidate baseline runner (read-only against the compiler). Usage: npx tsx run-baseline.mts [out.json]
// Reports ingestion (layout) and semantic metrics SEPARATELY. Output is a CANDIDATE, never written to baselines/.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSources } from '../../../apps/cli/dist/commands/compiler/source-collection.js';
import { compileSources } from '@xo/compiler';
import { extractDocxText } from '../../compiler/src/sources/docx-text.ts';
import { identifyDomain } from '../../compiler/src/knowledge-layer/identify.ts';
import { BUILT_IN_PACKS } from '../../compiler/src/knowledge-layer/packs/index.ts';
import { interpretPrompt } from '../../compiler/src/prompt/interpret.ts';
import { nodesOfKind } from '@xo/xoir';
import { NodePdfLoader } from '../../compiler/src/pdf/pdf-loader.ts';
import { parseDocument } from '../../compiler/src/document/document-parser.ts';
import { classifySentenceKind } from '../../compiler/src/document/content-classification.ts';
import { policyTextFromParsed } from '../../compiler/src/policy/from-document.ts';

const here = dirname(fileURLToPath(import.meta.url));
const gold: any = JSON.parse(readFileSync(join(here, 'xdomain.gold.json'), 'utf8'));
const STOP = new Set('the a an of to is are be by for in on or and if with that this any each than at as it its from not may must shall will'.split(' '));
const toks = (s: string) => (s.toLowerCase().match(/[a-z0-9₹%.,]+/g) ?? []).map((t) => t.replace(/[.,]+$/, '')).filter((t) => t && !STOP.has(t));
const leaves = (sc: any): number => (sc === undefined ? 0 : sc.type === 'and' || sc.type === 'or' ? sc.operands.reduce((a: number, o: any) => a + leaves(o), 0) : 1);
const pct = (n: number, d: number) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);

// ───────── semantic layer ─────────
const sem: any = { perDoc: {}, totals: {}, kindConfusion: {} };
const K = { n: 0, ok: 0, refNormativeFalse: 0, ref: 0 };
const T = { normative: 0, covered: 0, uncoveredSilent: 0, condClauses: 0, condTruncated: 0, condPartial: 0, condUnstructured: 0, modEval: 0, modOk: 0, outEval: 0, outOk: 0, lostGold: 0, lostFlagged: 0, flaggedNotLost: 0, excClauses: 0, excCaptured: 0, mayClauses: 0, mayAsRule: 0, ruleNodes: 0, unmatchedRuleNodes: 0, refRuleNodes: 0, modalityRepresented: 0, ruleNodesTotal: 0, policyTree: 0, docs: 0 };
for (const [slug, d] of Object.entries<any>(gold.documents)) {
  const c = await collectSources([join(here, 'corpus', `${slug}.md`)]);
  const r: any = await compileSources(c.inputs as any, {});
  if (!r.ok) { sem.perDoc[slug] = { error: r.error.message }; continue; }
  const v = r.value; T.docs++;
  if (v.policy !== undefined) T.policyTree++;
  const nodes: any[] = [...nodesOfKind(v.graph, 'heuristic'), ...nodesOfKind(v.graph, 'decision_node'), ...nodesOfKind(v.graph, 'constraint')];
  const ruleNodes = nodes.filter((n) => n.kind !== 'constraint' || n.properties?.structuredCondition !== undefined);
  const nodeText = (n: any) => toks([n.properties?.condition, n.properties?.question, n.properties?.action, n.properties?.outcome, n.properties?.rule].filter(Boolean).join(' '));
  const used = new Set<string>(); let covered = 0, norm = 0, trunc = 0, condC = 0, exc = 0, excCap = 0, may = 0, mayRule = 0;
  const detail: any[] = [];
  for (const k of d.clauses) {
    const gk = k.type === 'rule' || k.type === 'obligation' || k.type === 'permission' || k.type === 'prohibition' || k.type === 'procedure' || k.type === 'definition' || k.type === 'reference' ? k.type : undefined;
    if (gk) { const pk = classifySentenceKind(k.text); K.n++; if (pk === gk) K.ok++; const key = `${gk}->${pk}`; sem.kindConfusion[key] = (sem.kindConfusion[key] ?? 0) + 1; if (gk === 'reference') { K.ref++; if (!['reference', 'definition', 'heading'].includes(pk)) K.refNormativeFalse++; } }
    const ct = new Set(toks(k.text));
    let best: any, bestS = 0;
    for (const n of nodes) { const nt = nodeText(n); if (nt.length < 3) continue; const s = nt.filter((t) => ct.has(t)).length / nt.length; if (s > bestS) { bestS = s; best = n; } }
    const hit = bestS >= 0.7 ? best : undefined; if (hit) used.add(hit.id);
    const isNorm = !['reference', 'definition'].includes(k.type);
    if (isNorm) { norm++; if (hit) covered++; }
    if (isNorm) {
      const flagged = (v.diagnostics ?? []).some((dd: any) => dd.code === 'coverage/normative-sentence-not-extracted' && String(dd.message).includes(k.text.slice(0, 40)));
      if (!hit) { T.lostGold++; if (flagged) T.lostFlagged++; } else if (flagged) T.flaggedNotLost++;
    }
    const p = hit?.properties ?? {};
    const sc = p.structuredCondition;
    if (isNorm && k.conditions >= 2) { condC++; if (hit && leaves(sc) < k.conditions) { trunc++; if (leaves(sc) > 0) T.condPartial++; else T.condUnstructured++; } }
    if (isNorm && k.exceptions > 0) { exc++; if (hit && (p.exceptionConditions?.length ?? 0) > 0) excCap++; }
    const GOLD_MOD: Record<string, string> = { must: 'obligation', must_not: 'prohibition', may: 'permission', should: 'advisory', declarative: 'declarative' };
    if (isNorm && hit && typeof p.modality === 'string' && GOLD_MOD[k.modality] !== undefined) { T.modEval++; if (p.modality === GOLD_MOD[k.modality]) T.modOk++; }
    if (isNorm && hit && typeof p.outcomeType === 'string') { T.outEval++; if (p.outcomeType === k.outcome) T.outOk++; }
    if (k.modality === 'may') { may++; if (hit && hit.kind !== 'constraint' && sc !== undefined && p.modality !== 'permission') mayRule++; }
    detail.push({ id: k.id, goldOut: k.outcome, typedOut: p.outcomeType ?? null, text: k.text.slice(0, 70), goldMod: k.modality, typedMod: p.modality ?? null, type: k.type, covered: !!hit, sc: sc?.type ?? null, leaves: leaves(sc), goldConds: k.conditions, exc: p.exceptionConditions?.length ?? 0, goldExc: k.exceptions });
  }
  const unmatchedRules = ruleNodes.filter((n) => !used.has(n.id)).length;
  const refRules = d.domain === 'research' ? ruleNodes.length : 0;
  const diag = (v.diagnostics ?? []).length;
  const modRep = ruleNodes.filter((n) => n.properties?.modality !== undefined || n.properties?.polarity !== undefined).length;
  sem.perDoc[slug] = { clauses: d.clauses.length, normative: norm, covered, truncatedCompound: `${trunc}/${condC}`, exceptionsCaptured: `${excCap}/${exc}`, permissionAsRule: `${mayRule}/${may}`, ruleNodes: ruleNodes.length, unmatchedRuleNodes: unmatchedRules, diagnostics: diag, policyTree: v.policy !== undefined, detail };
  T.normative += norm; T.covered += covered; T.uncoveredSilent += diag === 0 ? norm - covered : 0; T.condClauses += condC; T.condTruncated += trunc;
  T.excClauses += exc; T.excCaptured += excCap; T.mayClauses += may; T.mayAsRule += mayRule; T.ruleNodes += ruleNodes.length; T.unmatchedRuleNodes += unmatchedRules; T.refRuleNodes += refRules; T.modalityRepresented += modRep; T.ruleNodesTotal += ruleNodes.length;
}
T.uncoveredSilent = T.lostGold - T.lostFlagged; // lost AND not flagged by the coverage guard
sem.totals = { ...T, contentKindAccuracyPct: pct(K.ok, K.n), contentKindEvaluated: K.n, referenceMisreadAsNormative: `${K.refNormativeFalse}/${K.ref}`, clauseCoveragePct: pct(T.covered, T.normative), silentlyUncovered: T.uncoveredSilent, compoundTruncationPct: pct(T.condTruncated, T.condClauses), partialStructureSilentLoss: `${T.condPartial}/${T.condClauses}`, unstructuredFailClosed: `${T.condUnstructured}/${T.condClauses}`, exceptionCapturePct: pct(T.excCaptured, T.excClauses), silentLossGuardRecallPct: pct(T.lostFlagged, T.lostGold), silentLossGuardCaught: `${T.lostFlagged}/${T.lostGold}`, guardFlaggedButCovered: T.flaggedNotLost, outcomeAccuracyPct: pct(T.outOk, T.outEval), outcomeEvaluated: T.outEval, modalityAccuracyPct: pct(T.modOk, T.modEval), modalityEvaluated: T.modEval, unmatchedRuleNodePct: pct(T.unmatchedRuleNodes, T.ruleNodes), nodesCarryingModalityOrPolarityPct: pct(T.modalityRepresented, T.ruleNodesTotal), docsWithPolicyTree: `${T.policyTree}/${T.docs}` };

// ───────── prompt layer ─────────
const pg: any = JSON.parse(readFileSync(join(here, 'prompts.gold.json'), 'utf8'));
const promptRows: any[] = []; let pStmtOk = 0, pIntOk = 0, pReasonOk = 0, pConvOk = 0, pConvN = 0, pDropped = 0;
const ruleView = (graph: any) => [...nodesOfKind(graph, 'heuristic'), ...nodesOfKind(graph, 'decision_node'), ...nodesOfKind(graph, 'constraint')].map((n: any) => { const q = n.properties ?? {}; return JSON.stringify({ q: q.condition ?? q.question, o: q.outcome ?? q.action, m: q.modality, t: q.outcomeType, sc: q.structuredCondition ?? null }); }).sort();
for (const g of pg.prompts) {
  const r = interpretPrompt(g.text);
  const reasons = [...new Set(r.questions.map((q: any) => q.reason))].sort();
  const stmtOk = r.statements.length === g.statements, intOk = r.intents.length === g.intents, reasonOk = JSON.stringify(reasons) === JSON.stringify([...g.reasons].sort());
  if (stmtOk) pStmtOk++; if (intOk) pIntOk++; if (reasonOk) pReasonOk++;
  let converges: boolean | null = null; let dropped = false;
  if (g.statements > 0) {
    const a: any = await compileSources([{ kind: 'prompt', text: g.text, sourcePath: g.id, confirmedBy: 'benchmark' } as any], {});
    const b: any = await compileSources([{ kind: 'document', text: g.text, sourcePath: `${g.id}.md` } as any], {});
    converges = a.ok && b.ok && JSON.stringify(ruleView(a.value.graph)) === JSON.stringify(ruleView(b.value.graph));
    pConvN++; if (converges) pConvOk++;
    if (a.ok && ruleView(a.value.graph).length === 0) { pDropped++; dropped = true; }
  }
  promptRows.push({ id: g.id, stmtOk, intOk, reasonOk, gotReasons: reasons, converges, understoodButNoNodeExtracted: dropped });
}
sem.prompts = { n: pg.prompts.length, statementCountAccuracyPct: pct(pStmtOk, pg.prompts.length), intentCountAccuracyPct: pct(pIntOk, pg.prompts.length), questionReasonExactPct: pct(pReasonOk, pg.prompts.length), convergenceWithDocumentPath: `${pConvOk}/${pConvN}`, understoodButNoNodeExtracted: `${pDropped}/${pConvN}`, rows: promptRows };

// ───────── domain identification layer (config A = no retrieval, B = structured packs; C = + vectors, not implemented) ─────────
const dg: any = JSON.parse(readFileSync(join(here, 'domain-id.gold.json'), 'utf8'));
const dRows: any[] = []; let dOk = 0, dBOk = 0, unkN = 0, unkFp = 0, posN = 0, posOk = 0, mixN = 0, mixOk = 0;
for (const it of dg.items) {
  let text = it.text as string | undefined;
  if (it.file) text = readFileSync(join(here, it.file), 'utf8');
  if (it.pdf) { const lr: any = new NodePdfLoader().load(new Uint8Array(readFileSync(join(here, it.pdf))), it.pdf); const doc = lr.value ?? lr; text = policyTextFromParsed(parseDocument(doc), it.id).text; }
  const got = identifyDomain(text ?? '', BUILT_IN_PACKS);
  const ok = got.domain === it.expected;
  if (ok) dBOk++;
  if (it.expected === 'unknown' ? true : false) { unkN++; if (got.domain !== 'unknown') unkFp++; }
  else if (it.expected === 'mixed') { mixN++; if (ok) mixOk++; }
  else { posN++; if (ok) posOk++; }
  if ((it.expected === 'unknown')) dOk += got.domain === 'unknown' ? 1 : 0;
  dRows.push({ id: it.id, expected: it.expected, got: got.domain, ok, top: got.candidates[0] ? `${got.candidates[0].packId}:${got.candidates[0].score.toFixed(2)}` : null });
}
sem.domainIdentification = {
  n: dg.items.length,
  configA_noRetrieval_accuracyPct: pct(dg.items.filter((i: any) => i.expected === 'unknown').length, dg.items.length),
  configB_structuredPacks_accuracyPct: pct(dBOk, dg.items.length),
  configC_withVectors: 'not implemented (adopt only if it beats B)',
  knownDomainRecallPct: pct(posOk, posN), knownDomainRecall: `${posOk}/${posN}`,
  unknownFalsePositiveRatePct: pct(unkFp, unkN), unknownFalsePositives: `${unkFp}/${unkN}`,
  mixedAccuracy: `${mixOk}/${mixN}`,
  rows: dRows,
};

// ───────── ingestion / layout layer ─────────
const ing: any[] = [];
const fdir = join(here, 'formats');
const stress: any[] = JSON.parse(readFileSync(join(fdir, 'stress.clauses.json'), 'utf8'));
for (const f of readdirSync(fdir).filter((x) => !x.endsWith('.json')).sort()) {
  const slug = f.split('.')[0]!; const kind = f.split('.')[1]!;
  const clauses: any[] = slug === 'stress' ? stress : gold.documents[slug].clauses;
  let text = '', ocrPages = 0, pages = 0, status = 'ok', diag = 0, units = -1;
  try {
    const c = await collectSources([join(fdir, f)]);
    if (c.inputs.length === 0) status = `not collected (${(c.unsupported ?? []).map((u: any) => u.reason).join(';')})`;
    else {
      const r: any = await compileSources(c.inputs as any, {});
      if (!r.ok) status = `compile error: ${r.error.message}`;
      else { units = r.value.sources[0]?.unitCount ?? -1; diag = (r.value.diagnostics ?? []).length; }
    }
    if (f.endsWith('.docx')) {
      const dx = extractDocxText(new Uint8Array(readFileSync(join(fdir, f)))); if (dx.ok) text = dx.value;
    }
    if (f.endsWith('.pdf')) {
      const lr: any = new NodePdfLoader().load(new Uint8Array(readFileSync(join(fdir, f))), f);
      const doc = lr.value ?? lr; pages = doc.pages?.length ?? 0; ocrPages = (doc.pages ?? []).filter((p: any) => p.requiresOcr).length;
      text = policyTextFromParsed(parseDocument(doc), slug).text;
    }
  } catch (e: any) { status = `exception: ${e.message}`; }
  // reading order: position of each clause's opening words in the extracted text; fraction of adjacent clause pairs in order
  const norm = text.toLowerCase().replace(/\s+/g, ' ');
  // sequential in-order search: each clause's opening words must be found AFTER the previous clause's match
  let cursor = 0, inOrder = 0, pairs = 0;
  for (const k of clauses as any[]) {
    const prefix = k.text.toLowerCase().split(/\s+/).slice(0, 8).join(' ');
    if (norm.indexOf(prefix) < 0) continue; // absent text is a recall problem, not an order problem
    pairs++;
    const idx = norm.indexOf(prefix, cursor);
    if (idx >= 0) { inOrder++; cursor = idx + 1; }
  }
  const tset = new Set(toks(text));
  const rec = clauses.filter((k) => { const t = toks(k.text); return t.length > 0 && t.filter((x) => tset.has(x)).length / t.length >= 0.9; }).length;
  ing.push({ file: f, format: kind, pages, requiresOcrPages: ocrPages, units, diagnostics: diag, status, clauseTextRecallPct: f.endsWith('.pdf') || f.endsWith('.docx') ? pct(rec, clauses.length) : null, readingOrderPct: f.endsWith('.pdf') || f.endsWith('.docx') ? pct(inOrder, pairs) : null });
}
const report = { suiteId: gold.suiteId, status: 'CANDIDATE — not an accepted baseline; single-annotator synthetic gold', semantic: sem, ingestion: ing };
writeFileSync(process.argv[2] ?? join(here, 'baseline-candidate.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(sem.totals, null, 1)); console.table(ing.map((x) => ({ file: x.file, pages: x.pages, ocr: x.requiresOcrPages, units: x.units, diag: x.diagnostics, recall: x.clauseTextRecallPct, status: x.status.slice(0, 40) })));
for (const [k, v] of Object.entries<any>(sem.perDoc)) console.log(k.padEnd(12), v.error ?? `cov ${v.covered}/${v.normative} trunc ${v.truncatedCompound} exc ${v.exceptionsCaptured} may→rule ${v.permissionAsRule} nodes ${v.ruleNodes} unmatched ${v.unmatchedRuleNodes} diag ${v.diagnostics} tree ${v.policyTree}`);
