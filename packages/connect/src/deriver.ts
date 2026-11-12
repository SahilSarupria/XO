import { err, ok, type Result } from '@xo/types';
import {
  MAX_CANDIDATES_PER_EVIDENCE,
  STRUCTURED_RECORD_SCHEMA,
  StructuredRecordDeriver,
  type Candidate,
  type Deriver,
  type DeriverRefusal,
  type Evidence,
} from '@xo/environment-intelligence';

/**
 * Knowledge from structured record FILES. The filesystem connector (opt-in `structuredRecords`) carries the records of a file shaped
 * `{"schema":"ei.org-record.v1","records":[...]}` in its content evidence; this deriver hands each record to C5's shipped
 * `StructuredRecordDeriver` unchanged and concatenates the candidates, all citing the one file as evidence.
 *
 * Fail-safe, whole file: if ANY record is refused the file is refused with that reason. XO never keeps half of a file it did not fully
 * understand. A file whose candidates would exceed C5's per-evidence limit is refused as `limit_exceeded` (split it into smaller files).
 * Evidence that is not a record file is passed to the shipped deriver as is (single-record payloads work; everything else is refused as
 * `unsupported_schema`, never guessed).
 */
export class FileRecordsDeriver implements Deriver {
  readonly id = 'xo.connect.file-records';
  readonly version = '1';
  private readonly inner = new StructuredRecordDeriver();

  derive(evidence: Evidence): Result<readonly Candidate[], DeriverRefusal> {
    const records = evidence.payload['records'];
    if (evidence.payload['schema'] !== STRUCTURED_RECORD_SCHEMA || !Array.isArray(records)) return this.inner.derive(evidence);
    const out: Candidate[] = [];
    for (const record of records) {
      const one = this.inner.derive({ ...evidence, payload: { schema: STRUCTURED_RECORD_SCHEMA, record } } as Evidence);
      if (!one.ok) return err(one.error);
      out.push(...one.value);
      if (out.length > MAX_CANDIDATES_PER_EVIDENCE) return err('limit_exceeded');
    }
    return ok(out);
  }
}
