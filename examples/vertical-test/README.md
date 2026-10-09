# XO Vertical Test — Capability Discovery → Execution Binding → First Executable XO

Proves the full chain end to end against a real (if synthetic) source
document: automatic capability + rule discovery in the compiler, a
generic `SemanticCapabilityContract`, deterministic binding resolution,
packaging through the real, unmodified Packager, sign/validate/install,
Runtime capability-authority registration, permission-gated execution
(denied, then allowed), a provenance-carrying receipt, and a determinism
check.

## The fixture is synthetic

`synthetic-claim-rules.txt` is a short document **authored solely for
this test**. It is not a real insurance policy, was not derived from any
real insurer's underwriting rules, and must never be treated as one. It
exists only to give the compiler's existing, unmodified extractors
(title-based capability detection, `IF/THEN` decision-rule parsing)
something genuinely actionable to find — see the design report for why
the repository's real PDF fixture (`burglary-policy.pdf`, a blank
template) could not support this.

`burglary-policy.pdf` (used by `examples/e2e-pdf`) is unrelated and untouched.

## Running it

```
node --import tsx examples/vertical-test/run.ts
```

Writes `output/vertical-test-report.json` — every step's pass/fail
status, the discovered contract, the resolved binding's derivation, and
the final execution receipt.
