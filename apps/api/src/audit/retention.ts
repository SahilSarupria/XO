/**
 * Audit retention is an OPERATOR decision, never a number this server invents. The operator declares it with
 * `XO_API_AUDIT_RETENTION_DAYS` (a positive integer); with nothing declared the API reports `minimumDays: null`
 * ("no retention policy declared") rather than a default that could be mistaken for a legal commitment.
 *
 * Either way the server has no code path that deletes or truncates audit entries, and it cannot guarantee the
 * durability of its own storage — the declaration is a statement by the operator, surfaced in the audit export.
 */
export function declaredRetentionDays(env: Readonly<Record<string, string | undefined>> = process.env): number | null {
  const raw = env['XO_API_AUDIT_RETENTION_DAYS'];
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 36500 ? n : null;
}
