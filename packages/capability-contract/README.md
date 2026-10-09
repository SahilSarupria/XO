# @xo/capability-contract

Projects a compiler-discovered XOIR `capability` node (plus any linked
`decision_node`/`heuristic`/`constraint` rule nodes) into a portable,
JSON-shaped `SemanticCapabilityContract`, and resolves that contract to an
executable implementation via a small, extensible set of `BindingResolver`s.

## Why this package exists, and not `@xo/compiler` or `@xo/runtime` directly

`@xo/compiler` depends on `@xo/xoir`. `@xo/runtime` does not (verified
directly against both packages' `package.json`s — Runtime's dependency
graph has no path to `@xo/xoir`, even transitively through
`@xo/package-sdk`). Runtime needs to be able to mount and reason about any
compliant `.xo` package, not only ones this specific compiler produced, so
it must not be forced to understand XOIR's node/edge model just to check
whether a mounted package carries a capability contract.

This package is the seam: `@xo/compiler` uses `contract-builder.ts` and
`contract-embed.ts` (which need a live `XoirGraph`) to build a contract at
compile time and embed it as plain JSON into the capability node's
`properties` bag (which the existing, unmodified Packager already carries
through opaquely into `knowledge_graph.json`). `@xo/runtime` uses
everything else in this package — `types.ts`, `comparison-grammar.ts`,
`structured-comparison-resolver.ts`, `resolve-binding.ts`,
`contract-extract.ts` — none of which import from `@xo/xoir`, even at the
type level, to read that plain-JSON contract back and attempt binding
resolution, without ever needing to understand XOIR itself.

## Known limitation

This package's own `package.json` still lists `@xo/xoir` as a dependency
(because `contract-builder.ts`/`contract-embed.ts` need it), so it is a real, transitive npm
dependency of anything that imports this package — including
`@xo/runtime`. Runtime's *source code* never imports from `@xo/xoir`
(only from this package's xoir-free modules), so this doesn't reintroduce
the behavioral coupling described above (Runtime still never assumes
XOIR-shaped content on a mounted package in general — it only
opportunistically reads the one optional, additive
`semanticCapabilityContract` field when present). But it does mean
Runtime's build graph technically includes `@xo/xoir` as a package that
gets built, even though Runtime's code never touches it. A stricter split
(two packages: `@xo/capability-contract-build`, depended on only by the
compiler, and `@xo/capability-contract-resolve`, depended on only by the
runtime) would remove even that, at the cost of an extra package for a
first vertical — left as a documented, deliberate trade-off rather than
implemented now (see the brief's "do not overbuild").

## Binding resolution — v1 grammar

The only `BindingResolver` implemented is `StructuredComparisonBindingResolver`,
which resolves a contract only when every linked rule's condition matches
this closed comparison grammar:

| Phrase | Operator |
|---|---|
| `exceeds`, `is more than`, `is greater than` | `>` |
| `is less than`, `is under` | `<` |
| `is at least` | `>=` |
| `is at most` | `<=` |
| `equals`, `is equal to` | `==` |
| `is not equal to`, `does not equal` | `!=` |

Anything else — a compound condition, a non-numeric comparison, a rule with
an exception clause, an unmatched field name — resolves `unresolved`, never
a guess.
