/**
 * Detector for RESTRICTED AUDIT DATA (P1.0 M4). Lives in the dependency-free base package so every AI / context /
 * retrieval / memory ingestion boundary can refuse audit records without depending on `@xo/audit`.
 *
 * It matches (to bounded depth): an audit event object (`classification: "restricted"` + `eventId` + `schemaVersion`),
 * a durable receipt (`kind: "xo.audit.receipt"`), and a JSON string containing a serialized audit event. It is a
 * conservative structural check, not a classifier of arbitrary text: audit data that has been transformed (summarised,
 * re-keyed, or paraphrased) before reaching a boundary is outside what a structural guard can see — callers must not
 * hand audit records to the model path at all (see docs/audit-operations.md, "Model exclusion").
 */
export function isAuditData(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    return value.includes('"classification":"restricted"') && value.includes('"schemaVersion"') && value.includes('"eventId"');
  }
  if (typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  if (rec['classification'] === 'restricted' && 'eventId' in rec && 'schemaVersion' in rec) return true;
  if (rec['kind'] === 'xo.audit.receipt') return true;
  const values = Array.isArray(value) ? value : Object.values(rec);
  return values.some((v) => isAuditData(v, depth + 1));
}
