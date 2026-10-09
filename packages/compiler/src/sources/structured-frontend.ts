import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';
import type { DocumentBlock, StructuredRawValue } from '../document/types.js';
import type { SourceFrontend, SourceIngestContext } from './frontend.js';
import type { CanonicalSource } from './types.js';
import { computeSourceId } from './source-id.js';
import { parsedDocumentFromBlocks, syntheticProvenance } from './block-source-helpers.js';

export type StructuredFormat = 'json' | 'csv';

export interface StructuredSourceInput {
  readonly kind: 'structured';
  readonly format: StructuredFormat;
  readonly text: string;
  readonly sourcePath: string;
}

function isStructuredSourceInput(input: unknown): input is StructuredSourceInput {
  if (typeof input !== 'object' || input === null) return false;
  const candidate = input as Partial<StructuredSourceInput>;
  return candidate.kind === 'structured' && (candidate.format === 'json' || candidate.format === 'csv') && typeof candidate.text === 'string' && typeof candidate.sourcePath === 'string';
}

type Record_ = Readonly<Record<string, unknown>>;

function fieldToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Preserves a field's already-parsed value as-is when it's already one of `StructuredRawValue`'s four shapes (every CSV cell, and most JSON leaf values); otherwise (a nested JSON object/array, or `undefined`) falls back to the same stringified form `fieldToText` already produces for `ParagraphBlock.text`, so `structuredField.rawValue` never diverges from what the block's own text says for those cases — no recursive field/path semantics are introduced. */
function toStructuredRawValue(value: unknown): StructuredRawValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return fieldToText(value);
}

function parseJson(text: string): Result<readonly Record_[], string> {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(text);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : 'invalid JSON' };
  }
  const asArray = Array.isArray(parsedValue) ? parsedValue : [parsedValue];
  for (const item of asArray) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, error: 'every JSON record must be an object' };
    }
  }
  return { ok: true, value: asArray as Record_[] };
}

/**
 * The one deliberately narrow, EXPLICIT structured-operation shape this
 * frontend recognizes (see `structured-operation-extractor.ts` for what
 * happens downstream). Gated strictly on the reserved `type: "operation"`
 * discriminant — an ordinary JSON record with fields that merely happen
 * to be named "inputs"/"outputs"/"formula"/"derived_from" is NEVER
 * treated as an operation; only this exact, explicit marker is. This is
 * the only place in the compiler that recognizes this shape — nothing
 * about it is inferred from field-name vocabulary elsewhere.
 */
export interface StructuredOperationParameter {
  readonly type?: string;
}

export interface StructuredOperationRecord extends Record<string, unknown> {
  readonly type: 'operation';
  readonly name: string;
  readonly inputs?: Readonly<Record<string, StructuredOperationParameter>>;
  readonly outputs?: Readonly<Record<string, StructuredOperationParameter>>;
  /**
   * Optional, explicit, narrow: names of other operations (by their
   * exact `name`) this one depends on — a separate declared fact from
   * the input/output parameter names, deliberately NOT inferred from
   * matching an input name against another operation's output name.
   * Structural corroboration for the data-flow authority rules must
   * come from independent evidence, never from the same name-match the
   * binding itself is trying to prove (see
   * `@xo/workflow-composer#auditWorkflowDataFlow`, which explicitly
   * excludes name-similarity-alone from proving a binding) — this field
   * is that independent evidence.
   */
  readonly requires?: readonly string[];
}

function isParameterMap(value: unknown): value is Readonly<Record<string, StructuredOperationParameter>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((p) => typeof p === 'object' && p !== null && !Array.isArray(p));
}

function isOperationRecord(record: Record_): record is StructuredOperationRecord {
  if (record.type !== 'operation') return false;
  if (typeof record.name !== 'string' || record.name.trim().length === 0) return false;
  if (record.inputs !== undefined && !isParameterMap(record.inputs)) return false;
  if (record.outputs !== undefined && !isParameterMap(record.outputs)) return false;
  if (record.requires !== undefined && !(Array.isArray(record.requires) && record.requires.every((r) => typeof r === 'string'))) return false;
  return true;
}

function parameterType(param: StructuredOperationParameter | undefined): string {
  return typeof param?.type === 'string' && param.type.trim().length > 0 ? param.type.trim() : 'unknown';
}

/**
 * Field-name convention consumed by `structured-operation-extractor.ts`:
 * `operation:name`, `operation:input:<paramName>`,
 * `operation:output:<paramName>` — namespaced so it can never collide
 * with an ordinary structured field's own name (which a user's data can
 * make arbitrary). Declaration only: no runtime *values* are carried
 * here, exactly per this milestone's "separate declaration from value"
 * requirement — a workflow execution later supplies actual
 * `premium`/`rate` numbers and receives an actual `brokerage` number
 * through the ordinary runtime capability-authority path, not through
 * this source representation.
 */
export function blocksForOperationRecord(record: StructuredOperationRecord, recordIndex: number): readonly DocumentBlock[] {
  const inputEntries = Object.entries(record.inputs ?? {});
  const outputEntries = Object.entries(record.outputs ?? {});
  const requiresEntries = record.requires ?? [];
  const fieldCount = 1 + inputEntries.length + outputEntries.length + requiresEntries.length; // operation:name + one block per input/output/requires entry
  const blocksForRecord = 1 + fieldCount; // heading + fields

  const blocks: DocumentBlock[] = [
    {
      kind: 'heading',
      level: 1,
      text: `Operation: ${record.name}`,
      provenance: syntheticProvenance(recordIndex + 1, 0, blocksForRecord),
    },
    {
      kind: 'paragraph',
      text: `operation name: ${record.name}`,
      provenance: syntheticProvenance(recordIndex + 1, 1, blocksForRecord),
      structuredField: { fieldName: 'operation:name', rawValue: record.name },
    },
  ];

  let fieldIndex = 2;
  for (const [paramName, param] of inputEntries) {
    const type = parameterType(param);
    blocks.push({
      kind: 'paragraph',
      text: `input ${paramName}: ${type}`,
      provenance: syntheticProvenance(recordIndex + 1, fieldIndex, blocksForRecord),
      structuredField: { fieldName: `operation:input:${paramName}`, rawValue: type },
    });
    fieldIndex += 1;
  }
  for (const [paramName, param] of outputEntries) {
    const type = parameterType(param);
    blocks.push({
      kind: 'paragraph',
      text: `output ${paramName}: ${type}`,
      provenance: syntheticProvenance(recordIndex + 1, fieldIndex, blocksForRecord),
      structuredField: { fieldName: `operation:output:${paramName}`, rawValue: type },
    });
    fieldIndex += 1;
  }
  for (const requiredName of requiresEntries) {
    blocks.push({
      kind: 'paragraph',
      text: `requires: ${requiredName}`,
      provenance: syntheticProvenance(recordIndex + 1, fieldIndex, blocksForRecord),
      structuredField: { fieldName: `operation:requires:${fieldIndex}`, rawValue: requiredName },
    });
    fieldIndex += 1;
  }

  return blocks;
}

/** Naive CSV: comma-separated, one row per line, no quoted-field/embedded-comma support — an explicit, documented limitation (Stage 8 §2's "do not overbuild"), not a bug. */
function parseCsv(text: string): Result<readonly Record_[], string> {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { ok: false, error: 'CSV has no content' };
  const headers = lines[0]!.split(',').map((h) => h.trim());
  if (headers.some((h) => h.length === 0)) return { ok: false, error: 'CSV header row has an empty column name' };

  const records: Record_[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map((c) => c.trim());
    const record: Record<string, unknown> = {};
    headers.forEach((header, i) => {
      record[header] = cells[i] ?? '';
    });
    records.push(record);
  }
  return { ok: true, value: records };
}

/**
 * The Structured family (Stage 8 §10): JSON and CSV, the two formats
 * that fit naturally with this repository's existing zero-dependency
 * approach (no new parser library needed). Each top-level record becomes
 * one `page` (mirroring "PDF page 7" — Stage 8 §12's provenance
 * example — a caller citing "record 42" is citing exactly the same kind
 * of location a PDF citation would use) with one heading block plus one
 * paragraph block per field, so field-level provenance survives into
 * `ExperienceUnit.provenance.blockProvenance` the same way a PDF
 * paragraph's does.
 */
export class StructuredSourceFrontend implements SourceFrontend<StructuredSourceInput> {
  readonly sourceType = 'structured' as const;

  canHandle(input: unknown): input is StructuredSourceInput {
    return isStructuredSourceInput(input);
  }

  ingest(input: StructuredSourceInput, _context?: SourceIngestContext): Result<CanonicalSource, SourceError> {
    const parsed = input.format === 'json' ? parseJson(input.text) : parseCsv(input.text);
    if (!parsed.ok) {
      return err(new SourceError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, `Structured source "${input.sourcePath}" (${input.format}) is invalid: ${parsed.error}`, { context: { sourcePath: input.sourcePath, format: input.format } }));
    }
    if (parsed.value.length === 0) {
      return err(new SourceError(ErrorCode.PRECONDITION_FAILED, `Structured source "${input.sourcePath}" contains no records`, { context: { sourcePath: input.sourcePath } }));
    }

    const blocks: DocumentBlock[] = [];
    parsed.value.forEach((record, recordIndex) => {
      if (isOperationRecord(record)) {
        blocks.push(...blocksForOperationRecord(record, recordIndex));
        return;
      }
      const fields = Object.entries(record);
      const blocksForRecord = 1 + fields.length; // heading + one paragraph per field
      blocks.push({
        kind: 'heading',
        level: 1,
        text: `Record ${recordIndex + 1}`,
        provenance: syntheticProvenance(recordIndex + 1, 0, blocksForRecord),
      });
      fields.forEach(([key, value], fieldIndex) => {
        blocks.push({
          kind: 'paragraph',
          text: `${key}: ${fieldToText(value)}`,
          provenance: syntheticProvenance(recordIndex + 1, fieldIndex + 1, blocksForRecord),
          structuredField: { fieldName: key, rawValue: toStructuredRawValue(value) },
        });
      });
    });

    const parsedDocument = parsedDocumentFromBlocks(blocks);
    const sourceId = computeSourceId('structured', input.sourcePath, input.text);

    return ok({
      sourceId,
      sourceType: 'structured',
      sourcePath: input.sourcePath,
      content: { kind: 'document', parsed: parsedDocument, documentTitle: undefined, plainText: input.text },
      metadata: { format: input.format, recordCount: String(parsed.value.length) },
      semanticExtractionAvailable: true,
    });
  }
}
