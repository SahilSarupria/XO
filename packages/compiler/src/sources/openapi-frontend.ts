import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';
import type { DocumentBlock } from '../document/types.js';
import type { SourceFrontend, SourceIngestContext } from './frontend.js';
import type { CanonicalSource } from './types.js';
import { computeSourceId } from './source-id.js';
import { parsedDocumentFromBlocks } from './block-source-helpers.js';
import { blocksForOperationRecord, type StructuredOperationRecord } from './structured-frontend.js';

export interface OpenApiSourceInput {
  readonly kind: 'openapi';
  readonly text: string;
  readonly sourcePath: string;
}

function isOpenApiSourceInput(input: unknown): input is OpenApiSourceInput {
  if (typeof input !== 'object' || input === null) return false;
  const candidate = input as Partial<OpenApiSourceInput>;
  return candidate.kind === 'openapi' && typeof candidate.text === 'string' && typeof candidate.sourcePath === 'string';
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only ever reads `schema.properties[name].type` — the smallest primitive-type slice of JSON Schema. Nested `$ref`, `items`, `oneOf`/`anyOf`/`allOf`, `additionalProperties`, and every other JSON Schema feature are deliberately out of scope (Stage 8 §2 "do not overbuild"); a property whose `type` isn't a plain string is recorded as `unknown` rather than the frontend attempting to resolve it. */
function schemaPropertyTypes(schema: unknown): Readonly<Record<string, string>> {
  if (!isRecord(schema)) return {};
  const properties = schema.properties;
  if (!isRecord(properties)) return {};
  const result: Record<string, string> = {};
  for (const [name, propertySchemaRaw] of Object.entries(properties)) {
    const propertySchema = isRecord(propertySchemaRaw) ? propertySchemaRaw : undefined;
    const type = propertySchema && typeof propertySchema.type === 'string' ? propertySchema.type : 'unknown';
    result[name] = type;
  }
  return result;
}

function jsonSchemaAt(container: unknown, ...path: readonly string[]): unknown {
  let current = container;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Request inputs: `requestBody.content["application/json"].schema.properties`.
 * Response outputs: `responses["200"].content["application/json"].schema.properties`
 * (only the 2xx-success `"200"` response is treated as the operation's
 * authoritative output — a `4xx`/`5xx`/`default` response describes an
 * error path, not what the operation produces on success, so those are
 * never inspected). Both are AUTHORITATIVE by construction: an OpenAPI
 * document's `requestBody`/`responses` schemas are what the API
 * contractually accepts/returns — this is the same kind of explicit,
 * structural, machine-readable declaration as the structured-JSON
 * milestone's `"outputs": {"brokerage": {"type": "number"}}` shape, just
 * expressed in OpenAPI's own standard vocabulary instead of a bespoke
 * one. `x-requires` is a standard OpenAPI vendor-extension field (the
 * spec reserves the `x-` prefix for exactly this) carrying the same
 * independent-structural-evidence role `requires` plays for structured
 * JSON — never inferred from matching a request property name against
 * another operation's response property name.
 */
function operationToStructuredRecord(operationId: string, operation: JsonRecord): StructuredOperationRecord {
  const inputTypes = schemaPropertyTypes(jsonSchemaAt(operation.requestBody, 'content', 'application/json', 'schema'));
  const outputTypes = schemaPropertyTypes(jsonSchemaAt(operation.responses, '200', 'content', 'application/json', 'schema'));
  const requiresRaw = operation['x-requires'];
  const requires = Array.isArray(requiresRaw) && requiresRaw.every((r) => typeof r === 'string') ? (requiresRaw as string[]) : undefined;

  return {
    type: 'operation',
    name: operationId,
    inputs: Object.fromEntries(Object.entries(inputTypes).map(([name, type]) => [name, { type }])),
    outputs: Object.fromEntries(Object.entries(outputTypes).map(([name, type]) => [name, { type }])),
    ...(requires ? { requires } : {}),
  };
}

/**
 * Deliberately minimal: OpenAPI 3.x, JSON representation only (this
 * repository adds no YAML parser dependency — see this milestone's
 * audit for why; a document already expressed as OpenAPI-in-JSON is
 * fully spec-compliant, so this is a scope reduction, not a
 * spec-compliance gap). Recognizes `paths.<path>.<method>` entries with
 * a string `operationId` only — a path/method combination without one
 * is skipped rather than a name being invented from the path, since an
 * invented name is not source evidence.
 *
 * Converts each recognized operation into the exact same
 * `StructuredOperationRecord` shape (and via the exact same
 * `blocksForOperationRecord`, zero duplicated logic)
 * `structured-frontend.ts`'s explicit `"type": "operation"` JSON records
 * already produce — everything downstream of block construction
 * (`structured-operation-extractor.ts`, XOIR, `SemanticCapabilityContract`,
 * `auditWorkflowDataFlow`, the runtime bridge) is completely shared and
 * unaware an OpenAPI document was ever involved. This is the
 * "source differences disappear before runtime" requirement satisfied
 * one layer earlier than runtime — at block construction, immediately
 * after ingest.
 */
export class OpenApiSourceFrontend implements SourceFrontend<OpenApiSourceInput> {
  readonly sourceType = 'openapi' as const;

  canHandle(input: unknown): input is OpenApiSourceInput {
    return isOpenApiSourceInput(input);
  }

  ingest(input: OpenApiSourceInput, _context?: SourceIngestContext): Result<CanonicalSource, SourceError> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.text);
    } catch (cause) {
      return err(new SourceError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, `OpenAPI source "${input.sourcePath}" is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, { context: { sourcePath: input.sourcePath } }));
    }
    if (!isRecord(parsed) || typeof parsed.openapi !== 'string' || !parsed.openapi.startsWith('3.') || !isRecord(parsed.paths)) {
      return err(new SourceError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, `OpenAPI source "${input.sourcePath}" is missing a recognizable "openapi": "3.x" version field and/or a "paths" object`, { context: { sourcePath: input.sourcePath } }));
    }

    const operations: { operationId: string; path: string; method: string; operation: JsonRecord }[] = [];
    for (const [path, pathItemRaw] of Object.entries(parsed.paths)) {
      if (!isRecord(pathItemRaw)) continue;
      for (const method of HTTP_METHODS) {
        const operationRaw = pathItemRaw[method];
        if (!isRecord(operationRaw)) continue;
        if (typeof operationRaw.operationId !== 'string' || operationRaw.operationId.trim().length === 0) continue; // no invented names from path/method
        operations.push({ operationId: operationRaw.operationId, path, method, operation: operationRaw });
      }
    }
    if (operations.length === 0) {
      return err(new SourceError(ErrorCode.PRECONDITION_FAILED, `OpenAPI source "${input.sourcePath}" contains no operation with an explicit "operationId"`, { context: { sourcePath: input.sourcePath } }));
    }

    const blocks: DocumentBlock[] = [];
    operations.forEach(({ operationId, path, method, operation }, index) => {
      const record = operationToStructuredRecord(operationId, operation);
      const recordBlocks = blocksForOperationRecord(record, index);
      // Replace the generic "Operation: <name>" heading with one that also
      // carries the path/method — real OpenAPI provenance, per this
      // milestone's Phase 6 (path + operationId), without inventing a
      // page/coordinate scheme for JSON.
      const [heading, ...rest] = recordBlocks;
      const headingBlock = heading as Extract<DocumentBlock, { kind: 'heading' }>;
      blocks.push({ ...headingBlock, text: `Operation: ${operationId} (${method.toUpperCase()} ${path})` }, ...rest);
    });

    const parsedDocument = parsedDocumentFromBlocks(blocks);
    const sourceId = computeSourceId('openapi', input.sourcePath, input.text);

    return ok({
      sourceId,
      sourceType: 'openapi',
      sourcePath: input.sourcePath,
      content: { kind: 'document', parsed: parsedDocument, documentTitle: undefined, plainText: input.text },
      metadata: { operationCount: String(operations.length) },
      semanticExtractionAvailable: true,
    });
  }
}
