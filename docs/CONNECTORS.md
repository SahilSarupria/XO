# Connectors (`@xo/connectors`)

The only path from a workflow to the outside world. Implemented: framework, grants, dry-run, secret vault + redaction, **HTTP** and **file** connectors.
**Not implemented yet:** MCP client, SMTP, Slack webhook, webhook-out, database, sandboxed code steps, external-vault adapters, durable retries/breakers (section C). Nothing here is measured.

## Order of checks (every one fails closed)

declared in the signed manifest -> granted in the operator policy -> implementation of the declared kind installed -> side-effect class agrees
-> declared secrets resolvable -> idempotency key present for side effects -> dry-run gate -> execute under a timeout (capped by the host).
Every call yields a `CallRecord` with request hash, response hash, duration and outcome (no bodies) for the ledger. Results are
`{ untrusted: true, provenance, data }`: text inside them is data, never instructions.

## Operator policy (local file, never shipped in the package)

```json
{ "connectors": { "api": { "grant": ["get"] }, "files": { "grant": ["write_record"] } } }
```

Endpoints, roots and credentials bind on the host: `httpConnector({ baseUrl, methods, pathPatterns, maxResponseBytes, bearerSecret })`,
`fileConnector({ roots: { out: '/var/xo/out' }, maxBytes })`. Secrets come from a `SecretVault` (`EnvVault` reads `XO_SECRET_<NAME>`, `FileVault`, `MapVault`);
`Redactor` strips every secret value from results, errors and records.

## HTTP hardening

Workflows pass a path only (never a host, headers or auth). Path must match an allowed pattern; traversal (including percent-encoded), `//`, backslashes
and query smuggling are refused. Hosts resolving to private/loopback/link-local/CGNAT/unique-local addresses (incl. v4-mapped v6) are refused unless
`allowPrivateNetwork` (dev only). Redirects are refused. Response size is enforced while streaming. Write calls send `Idempotency-Key`.
**Limit:** the address is checked at resolution time and the request then connects by hostname, so a DNS rebinding race is not fully closed; pin to an
egress proxy for hostile networks.

## File hardening

Logical roots only; lexical checks plus `realpath` confinement (symlink escapes refused). `write_record` is create-only via atomic `link`: an identical
replay is a no-op, different content is refused, and a crash never leaves a half-written target.

## Tests

`packages/connectors/test/connectors.test.ts` (17): ungranted/undeclared refusal, dry-run, secret redaction, prompt-injection text inert, SSRF, traversal,
redirects, size limits, timeouts, symlink escape.
