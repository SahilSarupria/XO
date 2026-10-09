import { Lexer } from './lexer.js';
import { isName, isPdfString, type PdfValue } from './types.js';

/** One run of text shown by a single `Tj`/`TJ`/`'`/`"` operator, in the coordinates of the page's default user space (after applying the text line matrix and the current transformation matrix, `cm`, in effect at the time — see `transformPoint` below). */
export interface TextRun {
  readonly bytes: Uint8Array;
  readonly fontName: string | undefined;
  readonly fontSizePt: number;
  readonly x: number;
  readonly y: number;
}

interface TextState {
  fontName: string | undefined;
  fontSizePt: number;
  /** Text line matrix translation only (`Td`/`TD`/`Tm`/`T*`) — this interpreter does not compose the full 2D affine text-rendering matrix (character/word spacing, horizontal scaling, and text-matrix rotation/skew are not folded in). That's sufficient to recover reading order and relative line/column position for Stage 2's layout heuristics, but not sub-pixel-accurate glyph coordinates — see this package's README for the consequence. This translation IS composed with the current graphics-state transformation matrix (`cm`, tracked separately below) before a run's final page-space `x`/`y` is recorded, since real-world content streams (e.g. one `q ... cm BT ... ET Q` block per line) routinely rely on `cm` to carry a text block's actual page position. */
  x: number;
  y: number;
  lineX: number;
  lineY: number;
  leading: number;
}

/** A 2D affine transformation matrix in PDF's row-vector convention (ISO 32000-1 §8.3.3): a point `(x, y)` maps to `(x*a + y*c + e, x*b + y*d + f)`. */
interface Matrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

const IDENTITY_MATRIX: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Composes two matrices as `cm` does: the result represents "apply `m1`, then `m2`" (i.e. `CTM' = m1 × CTM` in PDF's stated concatenation order). */
function multiplyMatrix(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.b * m2.c,
    b: m1.a * m2.b + m1.b * m2.d,
    c: m1.c * m2.a + m1.d * m2.c,
    d: m1.c * m2.b + m1.d * m2.d,
    e: m1.e * m2.a + m1.f * m2.c + m2.e,
    f: m1.e * m2.b + m1.f * m2.d + m2.f,
  };
}

function transformPoint(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: x * m.a + y * m.c + m.e, y: x * m.b + y * m.d + m.f };
}

/** Approximate uniform scale magnitude of a matrix's linear part, used only to keep a run's recorded `fontSizePt` in the same coordinate space as its (now `cm`-transformed) `x`/`y` — this matters for `line-grouper.ts`'s gap/threshold heuristics, which compare font size and positional gaps directly. Axis-aligned scale (the common real-world case, e.g. `cm` values like `.75 0 0 .75 tx ty`) is recovered exactly; rotation/skew is not modeled, consistent with this module's existing translation-only text-matrix approximation. */
function matrixScaleMagnitude(m: Matrix): number {
  return Math.sqrt(m.a * m.a + m.b * m.b);
}

/**
 * Interprets a decoded content stream (ISO 32000-1 §9) far enough to
 * recover text runs with approximate position, font, and size — the
 * minimum a layout-aware document parser (Stage 2) needs to distinguish
 * a heading from a paragraph. Graphics-state save/restore (`q`/`Q`) and
 * the current transformation matrix (`cm`) are tracked so that a text
 * block's page-absolute position is correctly recovered even when a
 * document positions each line via `cm` rather than an absolute `Tm`/`Td`
 * (a common pattern from some real-world PDF generators). Other non-text
 * operators (path painting, color, clipping, XObjects other than as a
 * page/OCR signal) are consumed for correct tokenization but otherwise
 * ignored — this is a text/layout extractor, not a renderer.
 */
export function extractTextRuns(contentBytes: Uint8Array): readonly TextRun[] {
  const lexer = new Lexer(contentBytes);
  const runs: TextRun[] = [];
  const operandStack: PdfValue[] = [];
  const state: TextState = { fontName: undefined, fontSizePt: 0, x: 0, y: 0, lineX: 0, lineY: 0, leading: 0 };
  // Graphics state: current transformation matrix, with a `q`/`Q` save/restore stack. Independent of TextState — `BT`/`ET` do not touch it (ISO 32000-1 §9.4.1), and `cm` is not permitted between `BT` and `ET`, so it is always "settled" by the time a text-showing operator records a run.
  let ctm: Matrix = IDENTITY_MATRIX;
  const ctmStack: Matrix[] = [];

  const num = (v: PdfValue | undefined): number => (typeof v === 'number' ? v : 0);
  const pushRun = (bytes: Uint8Array) => {
    const pt = transformPoint(ctm, state.x, state.y);
    const scale = matrixScaleMagnitude(ctm);
    runs.push({ bytes, fontName: state.fontName, fontSizePt: state.fontSizePt * scale, x: pt.x, y: pt.y });
  };

  for (;;) {
    const token = lexer.next();
    if (token.kind === 'eof') break;

    switch (token.kind) {
      case 'number':
        operandStack.push(Number.parseFloat(token.text));
        continue;
      case 'name':
        operandStack.push({ kind: 'name', name: token.text });
        continue;
      case 'string':
      case 'hexstring':
        operandStack.push({ kind: 'string', bytes: token.bytes ?? new Uint8Array(0) });
        continue;
      case 'array_start': {
        const items: PdfValue[] = [];
        for (;;) {
          const t = lexer.next();
          if (t.kind === 'array_end' || t.kind === 'eof') break;
          if (t.kind === 'number') items.push(Number.parseFloat(t.text));
          else if (t.kind === 'string' || t.kind === 'hexstring') items.push({ kind: 'string', bytes: t.bytes ?? new Uint8Array(0) });
        }
        operandStack.push({ kind: 'array', items });
        continue;
      }
      case 'dict_start': {
        // Inline images (BI...ID...EI) and marked-content property lists use dictionaries; skip to the matching dict_end and discard — not relevant to text extraction.
        let depth = 1;
        while (depth > 0) {
          const t = lexer.next();
          if (t.kind === 'eof') break;
          if (t.kind === 'dict_start') depth += 1;
          if (t.kind === 'dict_end') depth -= 1;
        }
        continue;
      }
      default:
        break; // 'keyword' — an operator; fall through to the switch below
    }

    const op = token.text;
    switch (op) {
      case 'BT':
        state.x = 0;
        state.y = 0;
        state.lineX = 0;
        state.lineY = 0;
        break;
      case 'ET':
        break;
      case 'Tf': {
        const size = num(operandStack[operandStack.length - 1]);
        const fontOperand = operandStack[operandStack.length - 2];
        state.fontName = fontOperand !== undefined && isName(fontOperand) ? fontOperand.name : undefined;
        state.fontSizePt = size;
        break;
      }
      case 'TL':
        state.leading = num(operandStack[operandStack.length - 1]);
        break;
      case 'Td': {
        const ty = num(operandStack[operandStack.length - 1]);
        const tx = num(operandStack[operandStack.length - 2]);
        state.lineX += tx;
        state.lineY += ty;
        state.x = state.lineX;
        state.y = state.lineY;
        break;
      }
      case 'TD': {
        const ty = num(operandStack[operandStack.length - 1]);
        const tx = num(operandStack[operandStack.length - 2]);
        state.leading = -ty;
        state.lineX += tx;
        state.lineY += ty;
        state.x = state.lineX;
        state.y = state.lineY;
        break;
      }
      case 'Tm': {
        // Tm fully replaces the text line matrix; operands are [a b c d e f] — (e, f) is the new line origin.
        const f = num(operandStack[operandStack.length - 1]);
        const e = num(operandStack[operandStack.length - 2]);
        state.lineX = e;
        state.lineY = f;
        state.x = e;
        state.y = f;
        break;
      }
      case 'T*':
        state.lineY -= state.leading;
        state.x = state.lineX;
        state.y = state.lineY;
        break;
      case 'Tj':
      case "'":
      case '"': {
        if (op !== 'Tj') {
          state.lineY -= state.leading;
          state.x = state.lineX;
          state.y = state.lineY;
        }
        const strOperand = operandStack[operandStack.length - 1];
        if (strOperand !== undefined && isPdfString(strOperand)) {
          pushRun(strOperand.bytes);
        }
        break;
      }
      case 'TJ': {
        const arrOperand = operandStack[operandStack.length - 1];
        if (arrOperand !== undefined && arrOperand !== null && typeof arrOperand === 'object' && 'kind' in arrOperand && arrOperand.kind === 'array') {
          for (const item of arrOperand.items) {
            if (isPdfString(item)) {
              pushRun(item.bytes);
            }
          }
        }
        break;
      }
      case 'q':
        ctmStack.push(ctm);
        break;
      case 'Q':
        if (ctmStack.length > 0) ctm = ctmStack.pop()!;
        break;
      case 'cm': {
        const f = num(operandStack[operandStack.length - 1]);
        const e = num(operandStack[operandStack.length - 2]);
        const d = num(operandStack[operandStack.length - 3]);
        const c = num(operandStack[operandStack.length - 4]);
        const b = num(operandStack[operandStack.length - 5]);
        const a = num(operandStack[operandStack.length - 6]);
        ctm = multiplyMatrix({ a, b, c, d, e, f }, ctm);
        break;
      }
      default:
        break; // all other operators (path painting, color, clipping, XObjects) are intentionally ignored
    }

    operandStack.length = 0;
  }

  return runs;
}
