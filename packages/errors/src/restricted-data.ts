import { isAuditData } from '@xo/types';
import { ErrorCode } from './error-codes.js';
import { AuditError } from './domain-errors.js';

/**
 * Model-exclusion guard (P1.0 M4). Audit data is classified `restricted`; every AI/context/retrieval/memory
 * ingestion boundary calls this before admitting content. `boundary` names the call site (never the data).
 */
export function assertNotAuditData(value: unknown, boundary: string): void {
  if (isAuditData(value)) {
    throw new AuditError(
      ErrorCode.AUDIT_ACCESS_DENIED,
      `restricted audit data may not enter ${boundary} (model context / retrieval / memory / training exclusion)`,
    );
  }
}
