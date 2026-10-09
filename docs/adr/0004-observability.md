# ADR 0004: Vendor-neutral Logger/Tracer/Meter interfaces, console implementations for now

## Status
Accepted

## Context
Every future module (compiler, runtime, registry) needs structured logs,
traces, and metrics. Committing to a specific backend (pino for logs,
an OpenTelemetry SDK + a specific exporter for traces/metrics) before any
of those modules exist means guessing at configuration needs — sampling
rates, exporter endpoints, resource attributes — with no real workload to
validate the guess against.

## Decision
Define `Logger` (`@xo/logger`), `Tracer`/`Meter` (`@xo/observability`) as
interfaces modeled closely on the ecosystem-standard shapes (`Tracer`/
`Span` mirrors OpenTelemetry's API on purpose). Ship dependency-free
implementations (`ConsoleLogger`, `ConsoleTracer`, `ConsoleMeter`) that
satisfy those interfaces today, sufficient for local dev, tests, and this
module's CLI.

## Alternatives considered
- **Adopt pino + the OpenTelemetry SDK now**: rejected for this module —
  no service exists yet to generate a load profile that would justify a
  specific exporter/sampling configuration, and this module was
  built/verified in an environment without npm registry access (see
  `docs/TECH_STACK.md`'s sandbox note), so a dependency-free console
  implementation was also the only one that could be exercised there.
- **No observability abstraction — call `console.log`/a chosen SDK
  directly from business logic**: rejected because it would hard-wire a
  vendor choice into every future package's call sites instead of one
  composition point.

## Consequences
- Swapping in pino/OpenTelemetry later means writing one new class per
  interface (`PinoLogger implements Logger`, an OTel-backed `Tracer`) and
  changing the DI registration — zero call-site changes, by construction.
- Until that swap happens, nothing in this repo has real sampling,
  redaction, or export to an external system — logs go to stdout as JSON
  lines, spans/metrics go to debug-level logs. Acceptable for a
  foundation module with no production traffic yet.
