/**
 * An extractor refused to produce facts it cannot stand behind. The runner turns this into an ESCALATION carrying `code`, never
 * into a retry and never into a guess: when a model's answer cannot be verified, a person looks at the case.
 */
export type ExtractionRefusalCode =
  | 'UNGROUNDED_FACT' // a stated fact has no quote, the quote is not in the source text, or the quote does not support the value
  | 'EXTRACTION_UNPARSEABLE' // the answer was not the requested JSON
  | 'EXTRACTION_INVALID' // a value has the wrong type / is outside its enum
  | 'EXTRACTION_TRUNCATED' // the model stopped for length or a content filter
  | 'EXTRACTION_UNSUPPORTED_FIELD' // a field type the model path cannot express (fail closed rather than guess a mapping)
  | 'MODEL_CALL_BUDGET'; // the step's model-call budget would be exceeded

export class ExtractionRefused extends Error {
  /** Brand checked structurally so refusals are recognised even across duplicate copies of this module. */
  readonly escalates = true as const;
  constructor(
    readonly code: ExtractionRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExtractionRefused';
  }
}

export function isExtractionRefusal(e: unknown): e is ExtractionRefused {
  return e instanceof Error && (e as { escalates?: unknown }).escalates === true && typeof (e as { code?: unknown }).code === 'string';
}
