/**
 * UW-3 — what kind of document is this? Classification as PROPOSALS, never decisions (trust boundary T1).
 *
 * The engine is generic: it scores a source against a cue pack and returns the best-supported kinds, each with every cue that matched,
 * the text it matched and where (page, cell, email header, title or file name), so a reviewer can see why. Nothing here is ever
 * `confirmed`: confirming a kind is a person's act, recorded elsewhere, and nothing downstream may treat a proposal as fact.
 *
 * The cue pack is data, not code: the default below covers common business document kinds in plain English, and an operator or a
 * vertical replaces or extends it without touching the engine.
 */
import type { CanonicalSource } from './types.js';
import type { DocumentSection } from '../document/types.js';

export interface KindCue {
  /** Case-insensitive regular expression source. */
  readonly pattern: string;
  readonly weight: number;
  /** Where the cue counts; default anywhere. A title or file-name match is stronger evidence than a phrase deep in the body. */
  readonly in?: 'title' | 'filename' | 'body' | 'columns' | 'email';
}

export interface DocumentKindCues {
  readonly kind: string;
  readonly label: string;
  readonly cues: readonly KindCue[];
}

export interface KindEvidence {
  readonly cue: string;
  readonly matched: string;
  /** `page 3`, `Clients!B1`, `subject`, `title`, `file name`. */
  readonly where: string;
}

export interface DocumentKindProposal {
  readonly kind: string;
  readonly label: string;
  /** 0..1: the share of the strongest evidence this pack can give that was found. A ranking aid, not a probability. */
  readonly score: number;
  readonly status: 'proposed';
  readonly evidence: readonly KindEvidence[];
  readonly method: 'cue-pack/1';
}

export const DEFAULT_DOCUMENT_KIND_CUES: readonly DocumentKindCues[] = [
  {
    kind: 'certificate',
    label: 'Certificate',
    cues: [
      { pattern: '\\bcertificate\\b', weight: 3, in: 'title' },
      { pattern: '\\bcertificate\\b', weight: 2, in: 'filename' },
      { pattern: '\\bthis is to certify\\b|\\bhereby certif(y|ies)\\b', weight: 3 },
      { pattern: '\\b(valid (until|till|from)|date of issue|issued (on|by)|expiry date|certificate (no|number))\\b', weight: 1 },
    ],
  },
  {
    kind: 'invoice',
    label: 'Invoice or bill',
    cues: [
      { pattern: '\\b(tax )?invoice\\b|\\bbill of supply\\b', weight: 3, in: 'title' },
      { pattern: '\\binvoice\\b', weight: 2, in: 'filename' },
      { pattern: '\\b(invoice (no|number|date)|amount due|due date|gstin|subtotal|total payable)\\b', weight: 1 },
    ],
  },
  {
    kind: 'policy',
    label: 'Policy, terms or procedure',
    cues: [
      { pattern: '\\b(policy|terms and conditions|standard operating procedure|sop|guidelines?)\\b', weight: 3, in: 'title' },
      { pattern: '\\b(policy|terms|sop|procedure)\\b', weight: 1, in: 'filename' },
      { pattern: '\\b(must|shall|is required to|are required to|may not|is not permitted)\\b', weight: 0.5, in: 'body' },
    ],
  },
  {
    kind: 'contract',
    label: 'Contract or agreement',
    cues: [
      { pattern: '\\b(agreement|contract|memorandum of understanding)\\b', weight: 3, in: 'title' },
      { pattern: '\\b(agreement|contract)\\b', weight: 1, in: 'filename' },
      { pattern: '\\b(the parties|hereinafter|witnesseth|in witness whereof|effective date)\\b', weight: 1 },
    ],
  },
  {
    kind: 'statement',
    label: 'Statement of account',
    cues: [
      { pattern: '\\bstatement( of account)?\\b', weight: 3, in: 'title' },
      { pattern: '\\b(opening balance|closing balance|account (no|number)|transaction date)\\b', weight: 1 },
    ],
  },
  {
    kind: 'register',
    label: 'Register or list of records',
    cues: [
      { pattern: '\\b(register|list|roster|master|directory)\\b', weight: 2, in: 'title' },
      { pattern: '\\b(register|list|master|clients?|customers?|employees?)\\b', weight: 1, in: 'filename' },
      { pattern: '^(name|client|customer|employee|member|id|code|email|phone)\\b', weight: 1, in: 'columns' },
    ],
  },
  {
    kind: 'correspondence',
    label: 'Email or letter',
    cues: [
      { pattern: '.+', weight: 3, in: 'email' },
      { pattern: '\\b(dear (sir|madam|mr|ms)|yours (sincerely|faithfully)|kind regards)\\b', weight: 1 },
    ],
  },
  {
    kind: 'form',
    label: 'Form or application',
    cues: [
      { pattern: '\\b(application|form|claim form|request form)\\b', weight: 3, in: 'title' },
      { pattern: '\\b(signature of|applicant|please fill|tick (one|the appropriate))\\b', weight: 1 },
    ],
  },
];

interface Text {
  readonly text: string;
  readonly in: NonNullable<KindCue['in']>;
  readonly where: string;
}

function textsOf(source: CanonicalSource): Text[] {
  const out: Text[] = [];
  const file = source.sourcePath.split(/[\\/]/).pop() ?? source.sourcePath;
  out.push({ text: file.replace(/[_-]+/g, ' '), in: 'filename', where: 'file name' });
  if (source.content.kind !== 'document') return out;
  const content = source.content;
  if (content.documentTitle !== undefined) out.push({ text: content.documentTitle, in: 'title', where: 'title' });
  let firstHeading = true;
  const walk = (s: DocumentSection): void => {
    if (s.heading !== undefined) {
      out.push({ text: s.heading.text, in: firstHeading ? 'title' : 'body', where: `page ${s.heading.provenance.page}` });
      firstHeading = false;
    }
    for (const b of s.blocks) {
      const t = b.kind === 'table_row' ? b.cells.join(' ') : b.text;
      if (t.length > 0) out.push({ text: t, in: 'body', where: `page ${b.provenance.page}` });
    }
    s.subsections.forEach(walk);
  };
  walk(content.parsed.root);
  for (const set of content.tables?.recordSets ?? []) {
    for (const t of set.titles) out.push({ text: t.raw, in: 'title', where: t.ref });
    for (const c of set.columns) if (c.headerRef !== undefined) out.push({ text: c.header, in: 'columns', where: c.headerRef });
  }
  if (content.email !== undefined) {
    out.push({ text: content.email.from ?? content.email.subject ?? 'email', in: 'email', where: 'email headers' });
    if (content.email.subject !== undefined) out.push({ text: content.email.subject, in: 'title', where: 'subject' });
  }
  return out;
}

/**
 * Proposed kinds for a source, best first, at most `limit`. A kind needs at least one matching cue; each cue counts once per source
 * (repetition is not more evidence). Returns [] when nothing in the pack matches: "unknown" is an answer, not a failure.
 */
export function proposeDocumentKinds(
  source: CanonicalSource,
  pack: readonly DocumentKindCues[] = DEFAULT_DOCUMENT_KIND_CUES,
  limit = 3,
): DocumentKindProposal[] {
  const texts = textsOf(source);
  const proposals: DocumentKindProposal[] = [];
  for (const kind of pack) {
    const evidence: KindEvidence[] = [];
    let got = 0;
    let max = 0;
    for (const cue of kind.cues) {
      max += cue.weight;
      const re = new RegExp(cue.pattern, 'i');
      for (const t of texts) {
        if (cue.in !== undefined && t.in !== cue.in) continue;
        if (cue.in === undefined && t.in === 'filename') continue;
        const m = re.exec(t.text);
        if (m === null) continue;
        got += cue.weight;
        const start = Math.max(0, m.index - 40);
        const snippet = t.text
          .slice(start, m.index + m[0].length + 40)
          .replace(/\s+/g, ' ')
          .trim();
        evidence.push({ cue: cue.pattern, matched: snippet.length > 160 ? `${snippet.slice(0, 157)}...` : snippet, where: t.where });
        break;
      }
    }
    if (evidence.length > 0 && max > 0) {
      proposals.push({
        kind: kind.kind,
        label: kind.label,
        score: Math.round((got / max) * 100) / 100,
        status: 'proposed',
        evidence,
        method: 'cue-pack/1',
      });
    }
  }
  return proposals.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind)).slice(0, limit);
}
