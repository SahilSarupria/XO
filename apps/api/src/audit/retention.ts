/**
 * Audit retention, as a declared minimum. The API has no code path that deletes or truncates audit entries, so the
 * log is retained for at least as long as the storage directory is (indefinitely). "7 years" is the documented
 * *minimum commitment* a deployment is expected to back with durable storage — it is not enforced by the server
 * (the server cannot guarantee its own disk), and the export says so.
 */
export const DEFAULT_AUDIT_RETENTION_DAYS = 7 * 365;
