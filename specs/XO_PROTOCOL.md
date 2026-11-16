# XO Protocol
### An Open Standard for Portable AI Professional Capability

```
Document:     XO-PROTOCOL-1.0
Status:       Proposed Standard
Category:     Standards Track
Obsoletes:    None
Updates:      None
```

---

## Status of This Document

This document specifies an open, vendor-neutral protocol for the creation, distribution, verification, execution, and governance of Experience Objects (XOs). It does not describe any single company's product. It describes the rules that any independent implementation — compiler, runtime, registry, marketplace, validator, benchmark engine, or SDK — must follow to interoperate with every other independent implementation.

This document is at the same layer of the stack as HTTP is to web browsers, OCI is to container runtimes, or OAuth 2.0 is to identity providers: it defines contracts between independently-built systems, not the internals of any one system. Three documents already exist beneath this one and remain unmodified by it:

- **Experience Object Specification** (`SPECIFICATION.md`) — the XO package format.
- **XO Runtime — Architecture Specification** (`RUNTIME_ARCHITECTURE.md`) — a reference runtime design.
- **Experience Compiler — Architecture Specification** (`EXPERIENCE_COMPILER.md`) — a reference compiler design.

Those documents are **informative reference implementations** of what this protocol requires. Where this document and any of the three conflict on a normative point, this document governs, and the conflicting document is treated as a defect in that reference implementation to be corrected, not as an amendment to the protocol.

Distribution of this document is unlimited.

---

## 0. Conventions and Terminology

### 0.1 Requirement keywords

The keywords **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be interpreted as described in RFC 2119. A conforming implementation satisfies every applicable MUST and MUST NOT; failure to satisfy a SHOULD requires the implementation to document its reasoning.

### 0.2 Core terms

| Term | Definition |
|---|---|
| **Experience Object (XO)** | A signed, versioned, model-agnostic package encoding professional capability, per the XO Package Format. |
| **Experience IR (EIR)** | The canonical intermediate representation of expertise that every Compiler emits into and every XO is generated from. |
| **Compiler** | Any implementation that lowers heterogeneous source material into valid EIR and packages EIR into a conformant XO. |
| **Runtime** | Any implementation that loads, negotiates, and executes one or more XOs against a host AI model. |
| **Registry** | Any implementation that stores, indexes, and serves XOs and their metadata for resolution by name/identity. |
| **Marketplace** | A Registry augmented with commerce, licensing enforcement, and (optionally) a Challenge Network integration. |
| **SDK** | A language-specific library implementing the client-side contracts of this protocol (Registry Protocol, Distribution Protocol, Runtime embedding). |
| **CLI** | A command-line implementation of the Developer Experience Standard (§18). |
| **Validator** | Any implementation that checks an EIR or XO against the conformance rules of this protocol and produces a `ValidationReport`. |
| **Benchmark Engine** | Any implementation that executes a `BenchmarkSuite` against an XO and produces a `ScoreReport`. |
| **Challenge Network** | The open, cross-organizational protocol by which any party may submit evidence disputing a benchmark claim (§13). |
| **Identity Provider (IdP)** | Any implementation issuing verifiable identities to Publishers, Organizations, Compilers, and Runtimes (§7.1). |
| **Trust Authority** | An entity, or federation of entities, that anchors certificate chains used to verify signatures under this protocol (§7.4). |
| **Licensing Authority** | An entity that issues, tracks, and can be queried for the license terms and royalty graph attached to an XO's provenance (§11). |
| **Publisher** | The identity, verified by an IdP, that signs and is accountable for a published XO. |
| **Conformance Class** | A named subset of this protocol (Core, Extended, Enterprise, §4) that an implementation may claim compliance with. |

### 0.3 Notational conventions

Wire formats and record shapes in this document are expressed as typed field lists, not as an implementation language. A field marked `REQUIRED` MUST be present and non-null in every conformant instance; a field marked `OPTIONAL` MAY be omitted. This document never specifies storage engines, programming languages, or deployment topology — those are implementation choices explicitly left open by §3.

---

## 1. Introduction and Scope

### 1.1 Purpose

This protocol exists to guarantee one property above all others: **an XO produced by any conformant Compiler, from any organization, MUST execute correctly on any conformant Runtime, from any other organization, and MUST be discoverable, verifiable, and licensable through any conformant Registry, from any third organization** — without any of the three needing a business relationship, a shared codebase, or permission from one another. Interoperability is the specification; everything else in this document exists to make that guarantee enforceable rather than aspirational.

### 1.2 Non-goals

This protocol does NOT mandate:

- A single reference implementation as the only legitimate one.
- A single company, foundation, or registry as the sole source of XOs.
- Any specific programming language, storage engine, or deployment model.
- Any specific AI model architecture, training method, or inference stack.
- Central approval for publishing an XO (approval, where it exists, is a Registry-level or Marketplace-level policy, never a protocol-level gate — see §4.4).

### 1.3 Design philosophy

The protocol is model-agnostic, vendor-neutral, extensible, cryptographically verifiable, forward- and backward-compatible within stated windows (§6), enterprise-ready, decentralizable (no component is architecturally required to be centralized, though centralized implementations of any component are conformant), profession-agnostic, and governed by an open change process (§19). It is written to remain meaningful even as the specific shape of "AI model" changes over the next decade (§20); every normative rule in this document is stated in terms of interfaces and guarantees, never in terms of any 2026-era model architecture.

---

## 2. Ecosystem Layers

The ecosystem this protocol governs is layered. Each layer depends only on the layer beneath it and exposes a stable interface upward; a conformant implementation of any layer MUST NOT require implementation details of the layer above it.

```
┌────────────────────────────────────────────────────────────┐
│  L7  Applications           (chat apps, agents, IDE plugins) │
├────────────────────────────────────────────────────────────┤
│  L6  Runtime                (loads & executes XOs, §10)      │
├────────────────────────────────────────────────────────────┤
│  L5  Experience Objects     (signed packages, §5–6)          │
├────────────────────────────────────────────────────────────┤
│  L4  Experience IR (EIR)    (canonical capability graph)     │
├────────────────────────────────────────────────────────────┤
│  L3  Compiler                (source → EIR → XO)             │
├────────────────────────────────────────────────────────────┤
│  L2  Protocol                (THIS DOCUMENT)                 │
├────────────────────────────────────────────────────────────┤
│  L1  Cryptographic Infrastructure (identity, signing, §7)    │
├────────────────────────────────────────────────────────────┤
│  L0  Storage                 (content-addressed bytes)        │
└────────────────────────────────────────────────────────────┘
```

- **L0 — Storage.** Content-addressed byte storage. This protocol requires only that anything it governs be retrievable by content hash; it does not mandate a storage technology.
- **L1 — Cryptographic Infrastructure.** Identity issuance, key management, signing, and certificate chains (§7). This layer is what every higher layer's trust guarantees are built on.
- **L2 — Protocol.** This document. It does not itself store, compile, execute, or sell anything — it defines the contracts that L3 through L7 implementations must honor to interoperate.
- **L3 — Compiler.** Any conformant implementation of the Compiler role (§0.2); the reference architecture in `EXPERIENCE_COMPILER.md` is one such implementation, not the only legitimate one.
- **L4 — Experience IR.** The canonical, versioned representation of compiled expertise (§6.5). EIR is a protocol-level artifact, not an implementation detail of any one compiler — this is what allows independently built compilers to be compatible at all.
- **L5 — Experience Objects.** The packaged, signed, distributable unit (§5–6, §9). This is the boundary artifact that Registries store, Marketplaces sell, and Runtimes load.
- **L6 — Runtime.** Any conformant implementation of the Runtime role; `RUNTIME_ARCHITECTURE.md` is one such implementation.
- **L7 — Applications.** Out of scope for this protocol beyond the Runtime embedding contract (§10.4).

A component MAY span multiple layers in a single product (a Marketplace commonly spans Registry + commerce logic above L5) but MUST still expose the layer-appropriate protocol interfaces so that a component built by a different organization can substitute for any one layer.

---

## 3. Roles and Components

For each role, this section defines responsibilities, the interfaces it MUST expose, its boundaries (what it explicitly MUST NOT assume or require), ownership (who is accountable for its correct behavior), and dependencies.

### 3.1 Compiler

- **Responsibilities:** Ingest source material; produce conformant EIR (§6.5); optimize, validate, and package EIR into a conformant XO (§5–6).
- **Interfaces:** MUST accept a `CompilationRequest` and emit either a conformant `.xo` package plus `CompilerAttestation` (§7.3), or a `CompilationFailure` with structured diagnostics. MUST publish the EIR spec version(s) it targets.
- **Boundaries:** MUST NOT require a specific Runtime or Registry. MUST NOT embed Registry-specific or Marketplace-specific business logic (licensing terms, pricing) into EIR or XO structure beyond the standard `licensing/license.json` component.
- **Ownership:** The organization operating the Compiler is accountable for the accuracy of its `CompilerAttestation` claims; false attestation is a Trust Model violation (§7.6).
- **Dependencies:** L1 (signing keys), L2 (this protocol's EIR and XO schemas). MAY depend on a Licensing Authority for provenance-to-license resolution.

### 3.2 Runtime

- **Responsibilities:** Load one or more XOs; perform capability negotiation against a host model (§10.2); assemble context/weights per request; enforce safety policies bundled in loaded XOs; report execution telemetry usable for benchmark refresh.
- **Interfaces:** MUST implement the Capability Negotiation Protocol (§10.2) and the Distribution Protocol's fetch/verify contract (§9). MUST expose a conformance self-declaration (§4) discoverable by any XO it loads.
- **Boundaries:** MUST NOT require XOs to originate from any specific Compiler or Registry. MUST NOT silently ignore a `required: true` package component it cannot consume — it MUST either satisfy it or refuse to load the XO (§10.3).
- **Ownership:** The organization operating the Runtime is accountable for correctly enforcing bundled `SafetyPolicy` and `Constraint` records.
- **Dependencies:** L1 (signature verification), a Trust Anchor set (§7.4), optionally a Registry for resolution.

### 3.3 Registry

- **Responsibilities:** Store and index XOs; resolve names/namespaces to package content; serve discovery, replication, and mirroring per the Registry Protocol (§8).
- **Interfaces:** MUST implement `resolve(name, version_range) → PackageDescriptor`, `fetch(descriptor) → bytes`, and the Federation contract (§8.5) if it claims federated conformance.
- **Boundaries:** MUST NOT be the sole implementation permitted to exist — this protocol explicitly forbids any single Registry from being architecturally required (§8.1). MUST NOT mutate a package's content-addressed bytes; a Registry serves, it does not edit.
- **Ownership:** The operating organization is accountable for uptime and integrity of what it serves, not for the correctness of the XOs themselves (that accountability sits with the Publisher, per §7.2).
- **Dependencies:** L0 storage, L1 identity for Publisher verification, optionally a Licensing Authority.

### 3.4 Marketplace

- **Responsibilities:** Everything a Registry does, plus commerce (pricing, purchase, entitlement), and typically Challenge Network integration (§13) and public leaderboards (§12.7).
- **Interfaces:** A superset of the Registry interface; MUST NOT weaken any Registry-level guarantee (e.g., MUST NOT gate `resolve`/`fetch` for already-entitled users behind marketplace-proprietary protocols that break §8's Registry Protocol conformance).
- **Boundaries:** Commerce and entitlement logic is explicitly out of scope for this protocol's normative requirements beyond §11's licensing framework; a Marketplace's pricing model is a business decision, not a protocol concern.
- **Ownership/Dependencies:** As Registry (§3.3), plus a Licensing Authority relationship and typically an Identity Provider relationship for buyer identity.

### 3.5 SDK and CLI

- **Responsibilities:** Provide language- and workflow-level ergonomics over the Registry Protocol (§8), Distribution Protocol (§9), and Runtime embedding contract (§10.4). See §18 for the full Developer Experience Standard.
- **Boundaries:** An SDK/CLI MUST NOT introduce protocol-incompatible package formats "for convenience"; local/dev conveniences (e.g., unsigned local test XOs) MUST be clearly distinguished from conformant, publishable XOs and MUST NOT be loadable by a production Runtime without an explicit unsafe/dev-mode flag.

### 3.6 Validator

- **Responsibilities:** Check EIR and/or XO conformance to this protocol's schemas and the Validation stages required by `EXPERIENCE_COMPILER.md` §6 as a protocol-level minimum bar (§6.6); emit a signed `ValidationReport`.
- **Boundaries:** A Validator's approval is evidence, not law — no single Validator is a mandatory gate for publication (§4.4) unless a specific Registry's policy requires one. Multiple competing Validators MAY exist and MAY disagree; disagreement is resolved through the Challenge Network (§13), not by protocol fiat.

### 3.7 Benchmark Engine and Challenge Network

- **Responsibilities:** Execute portable `BenchmarkSuite` artifacts (§12) against a target XO+Runtime pairing and produce a `ScoreReport`; the Challenge Network (§13) is the open protocol by which any party can submit counter-evidence against a published `ScoreReport`.
- **Boundaries:** No single Benchmark Engine's `ScoreReport` is authoritative by protocol fiat; authoritativeness is a function of the signature chain, the Challenge Network's dispute history, and Registry/Marketplace-level trust policy — this protocol defines the mechanism, not who wins a given dispute.

### 3.8 Identity Provider, Trust Authority, Licensing Authority

- **Identity Provider:** Issues verifiable identities (§7.1) to Publishers, Organizations, Compilers, and Runtimes. Multiple IdPs MAY coexist; cross-IdP trust is established via Trust Anchor federation (§7.4), not by requiring a single IdP.
- **Trust Authority:** Roots one or more certificate chains used to verify signatures under §7. This protocol does not mandate a single global Trust Authority — it mandates that every conformant implementation publish which Trust Anchors it honors, so trust is explicit and auditable rather than implicit.
- **Licensing Authority:** Tracks license grants and the provenance-to-royalty graph referenced by `licensing/license.json` and `provenance/contributors.json`. MAY be operated by a Marketplace, a Registry, or an independent third party; the protocol defines the query interface (§11.6), not the operator.

---

## 4. Conformance

### 4.1 Conformance classes

| Class | Requires | Typical implementer |
|---|---|---|
| **Core** | §5–7, §9, §10.2–10.3 (identity, EIR/XO schema, distribution integrity, capability negotiation) | Any minimal implementation |
| **Extended** | Core + §8 (Registry Protocol), §12–13 (Benchmark & Challenge), §16 (Extension Framework) | Public Registries/Marketplaces, production Runtimes |
| **Enterprise** | Extended + §15 (Enterprise Standard: air-gapped operation, compliance, RBAC, audit) | Enterprise-internal deployments |

An implementation MUST declare which class(es) it conforms to and MUST NOT claim a class it does not fully satisfy; false conformance claims are a Trust Model violation handled identically to false attestation (§7.6).

### 4.2 Conformance is per-role, not per-organization

A single organization's product MAY implement multiple roles (a Marketplace commonly is Registry + Compiler-as-a-service + Benchmark Engine), but each role it implements is independently conformant-or-not; claiming Runtime conformance does not imply Compiler conformance.

### 4.3 Test suite obligation

Every Core-conformant implementation MUST pass the protocol's published conformance test suite (versioned alongside the protocol itself, §6.1) before publicly claiming conformance. The test suite is normative for pass/fail behavior; this document is normative for the underlying requirement.

### 4.4 No central approval gate

Conformance to this protocol is self-certified and independently verifiable (via the public test suite and the Challenge Network). No Registry, Marketplace, Trust Authority, or governance body has the unilateral power to prevent a conformant implementation from existing or interoperating — policy-level gates (an individual Registry choosing not to list an XO) are that Registry's business decision and bind only that Registry, never the ecosystem.

---

## 5. Experience Object Identity

### 5.1 Global identity

Every XO MUST have a globally unique identifier of the form:

```
xo:<namespace>/<publisher>/<name>@<version>
```

`namespace` scopes the identifier to a resolution domain (e.g., a Registry root or a reverse-DNS-style enterprise namespace for private XOs); `publisher` is a verified identity (§7.2); `name` is publisher-scoped and MUST be unique within `namespace/publisher`; `version` follows §6.4. The tuple `(namespace, publisher, name, version)` MUST resolve to exactly one immutable, content-addressed package across every conformant Registry that hosts it — this is the protocol's core uniqueness guarantee, enforced by the fact that the package's Merkle root (per `SPECIFICATION.md` §1.2) is itself derivable from and checkable against the identifier's resolved content.

### 5.2 Canonical references

A **canonical reference** is `xo:<namespace>/<publisher>/<name>@<version>#<merkle_root>` — the identifier plus content hash. Canonical references MUST be used in any context requiring non-repudiation (license grants, benchmark attestations, compiler provenance records referencing an upstream XO). Bare identifiers (without hash) are resolution conveniences and MUST always resolve to the same content for a given immutable version.

### 5.3 Namespaces, publishers, and organizations

- A **namespace** MAY be publicly registered (subject to the governance process, §19.6) or privately operated (enterprise/air-gapped, §15.1) — private namespaces are first-class, not a degraded mode.
- A **Publisher** identity is issued by an Identity Provider (§7.1) and is what signatures are checked against.
- An **Organization** MAY hold multiple Publisher identities (e.g., team-scoped signing keys) under one verified organizational root, mirroring standard code-signing certificate hierarchies.

### 5.4 Ownership, transfer, forks, mirrors, aliases

| Operation | Definition | Protocol requirement |
|---|---|---|
| **Ownership** | The Publisher(s) whose signature(s) are required to publish a new version under a given `(namespace, publisher, name)` | Recorded in `provenance/contributors.json`; transfers MUST be co-signed by outgoing and incoming Publisher, or arbitrated per §19.7 if outgoing Publisher is unreachable |
| **Transfer** | Reassignment of publish rights for a name | MUST be recorded as an immutable, signed event in the identity's provenance history; MUST NOT silently reassign an existing version's content |
| **Fork** | A new `(namespace, publisher, name)` derived from another XO's EIR, with full provenance chain preserved (per the Linker's provenance-union behavior, `EXPERIENCE_COMPILER.md` §2.3, §5.2) | MUST retain a `forked_from` canonical reference; licensing terms of the source MUST be honored (§11.8) |
| **Mirror** | A byte-identical replica hosted by a different Registry | MUST preserve the original canonical reference and signatures unmodified; a Registry MUST NOT re-sign mirrored content as if it were the original Publisher |
| **Alias** | A human-friendly or legacy name resolving to a canonical reference | MUST be resolvable but MUST NOT be treated as identity-equivalent for signature verification — verification always occurs against the canonical reference it resolves to |

### 5.5 Identity resolution algorithm (informative)

1. Parse the identifier into `(namespace, publisher, name, version_range)`.
2. Consult the namespace's authoritative Registry (or, for federated namespaces, any Registry in the federation, per §8.5).
3. Resolve `version_range` per §6.4's compatibility rules to a specific `version`.
4. Retrieve the `PackageDescriptor`, verify its Merkle root and signature chain (§7) before returning it to the caller.

---

## 6. Versioning

### 6.1 Independently versioned artifacts

This protocol requires semantic versioning (`MAJOR.MINOR.PATCH`) for six independently evolving artifact types, because coupling their version numbers would prevent exactly the independent-innovation property this protocol exists to protect:

| Artifact | Owner of version bumps | MAJOR bump means |
|---|---|---|
| **Protocol version** (this document) | Governance process (§19) | A change to normative requirements that is not backward compatible for at least one conformance class |
| **XO Package spec version** | Governance process, tracks `SPECIFICATION.md` | Package layout/manifest schema changes requiring Runtime updates to parse |
| **EIR spec version** | Governance process, tracks compiler middle-end contract | Node/edge taxonomy changes requiring Compiler/Validator updates |
| **Compiler version** | Implementing organization | Implementation's own release cycle; MUST declare which EIR spec version(s) it targets |
| **Runtime version** | Implementing organization | Implementation's own release cycle; MUST declare which XO Package spec version(s) it consumes |
| **Individual XO version** | Publisher | Per `SPECIFICATION.md`; capability-breaking changes to a published XO |

### 6.2 Compatibility is declared, not inferred

Every Compiler, Runtime, Registry, and Validator MUST publish a machine-readable `SupportedVersions` declaration listing every Protocol, EIR-spec, and Package-spec version range it supports. Implementations MUST NOT infer compatibility from version numbers alone (e.g., assuming all `1.x` are compatible) — the declared range is authoritative, because a MINOR protocol version is permitted to add optional fields that only some `1.x` implementations understand.

### 6.3 Compatibility matrix (informative example)

| | EIR 1.0 | EIR 1.1 | EIR 2.0 |
|---|---|---|---|
| Package spec 1.0 | Compatible | Compatible (additive fields ignored safely) | Requires spec 1.x→2.0 migration adapter |
| Package spec 1.1 | Compatible | Compatible | Compatible |

A Runtime declaring support for Package spec 1.1 MUST correctly load a package built by a Compiler targeting Package spec 1.0 (backward compatibility, §6.6) without requiring the Publisher to recompile.

### 6.4 Version range resolution

XO identifiers (§5.1) MAY specify a version range using standard semver range syntax (`^1.2.0`, `~1.2.0`, `>=1.2.0 <2.0.0`). A Registry resolving a range MUST select the highest version satisfying the range that also has a `SupportedVersions` intersection with the resolving Runtime's declaration, where the Runtime's declaration is known; otherwise it MUST return the highest matching version and let capability negotiation (§10.2) surface any incompatibility.

### 6.5 EIR versioning specifics

Because EIR (`EXPERIENCE_COMPILER.md` §3.5) is the layer every Compiler and every downstream consumer depends on, EIR MINOR versions MUST be additive-only (new optional node/edge kinds, new optional fields) and MUST NOT change the meaning of any existing node/edge kind. EIR MAJOR versions MAY be non-additive but MUST ship with a governance-approved migration mapping (§6.6) from the prior MAJOR version covering at least every node/edge kind that existed in it.

### 6.6 Backward and forward compatibility rules

- **Backward compatibility (new implementation, old artifact):** A conformant implementation of version `N` of any artifact type MUST correctly process every artifact validly produced under version `N-1` within the same MAJOR version, and SHOULD process the immediately prior MAJOR version via a documented migration path.
- **Forward compatibility (old implementation, new artifact):** A conformant implementation of version `N` MUST NOT crash, corrupt, or silently misinterpret an artifact produced under version `N+1` within the same MAJOR version — it MUST ignore fields/node-kinds it does not recognize and MUST report reduced capability rather than failing closed with a misleading error, wherever the artifact does not declare those unrecognized elements as `required`.
- Any field, node kind, or component that is safe to ignore MUST be explicitly marked non-required in its governing schema; anything that changes correctness if ignored MUST be marked required and MUST trigger an explicit incompatibility error, never a silent degradation.

### 6.7 Deprecation policy

A MINOR or MAJOR version MAY deprecate a field, node kind, or endpoint. Deprecation MUST be announced at least one MINOR version before removal, MUST be machine-discoverable (a `deprecated: true` + `sunset_version` annotation on the element itself), and removal MUST only occur at a MAJOR version boundary.

### 6.8 Long-term support (LTS)

The governance process (§19) MAY designate a Protocol MAJOR version as LTS, committing to security and critical-conformance-bug fixes (as MINOR/PATCH releases within that MAJOR line) for a published minimum duration, independent of whichever version is currently newest. Enterprise Conformance Class (§4.1) implementations SHOULD track an LTS line rather than the bleeding edge.

---

## 7. Trust Model

### 7.1 Identity verification

Every Publisher, Organization, Compiler instance, and Runtime instance participating in signature-checked operations MUST hold an identity issued by a conformant Identity Provider, consisting of a public key and verifiable claims (organization name, contact, and — where applicable — jurisdiction). Identity issuance itself is out of this protocol's normative scope (an IdP may use any KYC process it chooses) — this protocol only requires that the *resulting* identity be expressible as a standard certificate.

### 7.2 Publisher verification

A Publisher's signature over a package's Merkle root (per `SPECIFICATION.md` §1.1) is verified by walking a certificate chain from the Publisher's key to a Trust Anchor (§7.4) the verifying party honors. A Registry or Runtime MUST expose, per package, whether the Publisher signature verified, and against which Trust Anchor — verification status MUST NOT be silently assumed valid on cache hit without re-checking revocation status (§7.5) at a bounded staleness interval.

### 7.3 Compiler and Runtime attestation

Per `EXPERIENCE_COMPILER.md` §9.4, a Compiler MAY attach a `CompilerAttestation` claiming "this package was produced by Compiler `X` version `Y` from EIR passing Validation policy `Z`." A Runtime MAY similarly attach a `RuntimeAttestation` to execution telemetry, claiming which Runtime version and safety-policy-enforcement configuration produced a given benchmark run. Both attestation types are independently signed and independently optional — a package or run without one is not invalid, only lower-trust, and downstream consumers (Registries, Marketplaces, enterprise policy engines) MAY require attestation as a listing/deployment policy without that requirement being a protocol mandate.

### 7.4 Certificate chains and trust anchors

This protocol does not designate a single global root of trust. Every verifying implementation MUST publish its **Trust Anchor Set** — the root certificates it honors — and MUST allow that set to be configured (critical for Enterprise Conformance, §15.1, where an enterprise may run its own private Trust Authority for internal XOs). Cross-organization interoperability in the public ecosystem is achieved by convention: publicly listed Registries SHOULD honor a shared, governance-published Trust Anchor Set (§19.6) so that a Publisher verified by one IdP is recognized ecosystem-wide, without that convention being a hard protocol requirement for private deployments.

### 7.5 Revocation

Every Trust Authority MUST provide a revocation-checking interface (a revocation list or an OCSP-equivalent query) for keys it has issued or countersigned. Verifying implementations MUST check revocation status for Publisher and Compiler/Runtime attestation keys at least once per a bounded interval they publish, and MUST treat a revoked key's signatures on content published *after* the revocation timestamp as invalid; content signed *before* revocation retains its original validity unless the revocation reason explicitly claims retroactive compromise.

### 7.6 Auditability and false-attestation handling

Every signature, attestation, and `ValidationReport`/`ScoreReport` is an append-only, independently-fetchable artifact (§15.4 for audit log requirements at the Enterprise class). A false conformance or attestation claim, once demonstrated (via the Challenge Network, §13, or independent re-verification), MUST result in the offending key being reportable for revocation through the issuing Trust Authority; this protocol does not itself operate enforcement, only the evidentiary and revocation mechanism enforcement bodies use.

### 7.7 Supply chain security

The chain `Source Evidence → Compiler → EIR → XO Package → Registry → Runtime` is treated as a software supply chain and MUST be verifiable end-to-end: a Runtime MUST be able to verify not only the final package signature but, where a `CompilerAttestation` is present, that the attested Compiler identity and version are ones the verifying party's policy trusts, exactly as SLSA-style provenance verification works for container images.

---

## 8. Registry Protocol

### 8.1 No mandatory central registry

This protocol defines how Registries interoperate; it does not designate any single Registry as canonical. Any organization MAY operate a conformant Registry, public or private, without permission from any other party.

### 8.2 Discovery

A Registry MUST expose a discovery endpoint returning its namespace(s), supported protocol/spec versions (§6.2), and federation peers (§8.5), if any. Clients (SDKs, other Registries) resolve an unfamiliar namespace by a standard resolution order: explicit configuration, then well-known namespace-to-Registry mapping records, then federation peer lookup.

### 8.3 Replication, synchronization, and mirroring

A Registry MAY replicate content from another Registry. Replicated content MUST preserve original signatures and canonical references unmodified (§5.4). Synchronization between a Registry and its mirrors is a pull-based, content-addressed diff — a mirror MUST be able to determine what it is missing purely from Merkle roots it already holds versus a peer's index, without a proprietary sync protocol, so that mirroring across independently-built Registry implementations works.

### 8.4 Caching and package/dependency resolution

Registries and Runtimes MAY cache resolved packages keyed by canonical reference (§5.2), since immutable content is cache-safe indefinitely once signature-verified. Dependency resolution (an XO's linked or `requires` dependencies on other XOs, per the Linker's composition model) follows the same version-range resolution as §6.4, applied transitively; a Registry SHOULD detect and report dependency cycles or unsatisfiable ranges as a resolution error rather than partial success.

### 8.5 Offline, private, enterprise, and federated registries

- **Offline Registry:** MUST function with no network dependency once its local content store is populated (required for Enterprise Conformance, §15.1). Signature verification MUST work offline against a locally configured Trust Anchor Set (§7.4).
- **Private Registry:** Operates its own namespace(s), optionally never federating outward. Fully conformant without ever touching the public ecosystem.
- **Enterprise Registry:** A Private Registry additionally satisfying §15's compliance requirements.
- **Federated Registry:** A set of Registries that mutually recognize each other's namespaces and replicate discovery metadata (not necessarily content) between them, per a federation agreement outside this protocol's scope; the protocol only standardizes the technical peer-discovery and sync mechanism (§8.3), not the governance of who federates with whom.

---

## 9. Distribution Protocol

### 9.1 Package format

The distributable unit is the `.xo` package defined in `SPECIFICATION.md` §1. This protocol requires that format (or a governance-approved successor, §6.1) be used for any artifact claiming XO identity; it does not define a competing format.

### 9.2 Integrity verification

Every fetch MUST be followed by Merkle root recomputation and comparison against the value declared in the resolved `PackageDescriptor` before any component is considered trustworthy, per the content-hashing model in `SPECIFICATION.md` §1.1. A partial or corrupted fetch MUST fail integrity verification rather than load partially.

### 9.3 Compression, chunking, delta updates, streaming

- Packages MUST be independently decompressible per-component (per `SPECIFICATION.md`'s content-addressed, individually-hashed file layout), enabling chunked, resumable, and parallel fetch of large components (e.g., `weights/finetune/`) without requiring the whole package in memory.
- A Registry MAY serve delta updates between two known versions of the same `(namespace, publisher, name)` as a content-addressed diff against components whose hash is unchanged, avoiding re-transfer of identical knowledge-graph or safety-policy components across a patch version bump.
- Streaming fetch (begin using early components — e.g., `manifest.json`, `safety/rules.json` — while later, larger components are still transferring) MUST be supported by any Registry claiming CDN compatibility.

### 9.4 Resume and CDN/P2P compatibility

Because integrity is verified per-component via content hash, resuming an interrupted fetch, serving from any CDN edge, or fetching via peer-to-peer distribution (any peer that can supply bytes matching the declared hash) are all valid and MUST all be supported as fetch strategies by a conformant client — the protocol's trust model (§7) is what makes untrusted mirrors and P2P peers safe to fetch from at all, since correctness is verified by hash and signature, not by the identity of whoever served the bytes.

### 9.5 Air-gapped and enterprise deployment

A conformant Distribution Protocol client MUST support fully offline installation from a local, pre-verified package store (no network fetch required at load time) as a first-class mode, required for Enterprise Conformance (§15.1).

---

## 10. Runtime Interoperability

### 10.1 The interoperability guarantee

Restating §1.1 as a formal requirement: given a Runtime `R` (from organization A), an XO `X` (compiled by Compiler `C` from organization B, and hosted by Registry `G` from organization C), if `R` declares support for `X`'s Package spec version and at least one of `X`'s declared target model families, `R` MUST successfully load and correctly execute the capabilities `X` declares, subject only to the negotiated subset of components `R` can consume (§10.3) — never subject to which organization produced `C` or `G`.

### 10.2 Capability Negotiation Protocol

On load, a Runtime and an XO's manifest MUST agree on a **consumption set** — the subset of the XO's components the Runtime will actually use — via the following negotiation, generalized from `RUNTIME_ARCHITECTURE.md` §3:

1. Runtime declares its supported Package spec version(s) and the host model family/capabilities it is currently bound to.
2. XO manifest's `compatibility.model_families[]` (per `SPECIFICATION.md` §1.2) is matched against the declared host model family.
3. The intersection of the matched entry's `consumes[]` list and the Runtime's own implemented component types is the consumption set.
4. Any `required: true` component (§10.3) not in the consumption set is a hard negotiation failure; any `required: false` component not in the consumption set is silently excluded, and the Runtime MUST record that exclusion in its load telemetry so degraded-capability operation is observable, not silent.

### 10.3 Required-component enforcement

A Runtime MUST NOT load an XO for which a `required: true` component (per manifest declaration — `safety_rules` and `benchmark_suite` are required for every publicly listed XO per `SPECIFICATION.md`'s baseline policy) cannot be satisfied by its consumption set. This is the specific mechanism that prevents a Runtime from silently dropping a safety policy because it doesn't understand the component format — failure MUST be closed, not open.

### 10.4 Runtime embedding contract (informative)

An SDK embedding a Runtime into an application (L7, §2) exposes, at minimum: `install(xo_ref) → LoadResult`, `invoke(capability_ref, input) → output`, and `telemetry() → ExecutionTelemetry` streams usable for benchmark refresh (§12.9) and the compiler's Learning Loop (`EXPERIENCE_COMPILER.md` §10.1). The exact API shape is implementation-defined; only the presence of these three functional guarantees is normative.

---

## 11. Licensing Framework

### 11.1 License is a first-class, machine-readable artifact

Every XO's `licensing/license.json` component (per `SPECIFICATION.md`) MUST resolve to exactly one entry from the License Type Registry below, or a governance-approved custom license expressed in the same structured schema (grantor, grantee scope, permitted uses, restrictions, royalty terms) so that Registries and Runtimes can programmatically enforce terms rather than relying on prose interpretation.

### 11.2 License types

| Type | Redistribution | Forking | Commercial use | Typical royalty model |
|---|---|---|---|---|
| Open Source | Permitted | Permitted, provenance MUST be retained | Permitted | None, or attribution-only |
| Commercial (perpetual) | Prohibited unless explicitly granted | Prohibited unless explicitly granted | Grantee only | One-time or negotiated |
| Subscription | Prohibited | Prohibited | Grantee only, term-limited | Recurring, enforced by expiry field |
| Enterprise | Prohibited outside licensed org | Internal forks permitted if granted | Internal only, or as negotiated | Negotiated, often seat/usage-based |
| Academic | Non-commercial only | Permitted for research | Prohibited | None, or institution-fee |
| Government | As negotiated, often broader redistribution within agency | As negotiated | Public-sector use | As negotiated |
| Evaluation | Prohibited | Prohibited | Prohibited | None; MUST carry an expiry |

### 11.3 Usage restrictions

License records MAY constrain: field of use (e.g., "medical advice capabilities restricted to licensed-practitioner-supervised deployments"), geographic scope, deployment model (cloud-only vs. on-prem), and maximum request volume. Runtimes and Marketplaces enforcing licenses MUST treat these as structured fields, not free text, to remain machine-checkable.

### 11.4 Redistribution and forking rights

Redistribution and forking rights are independent fields (an Open Source license may permit both; an Enterprise license may permit neither). A fork (§5.4) MUST carry forward the source XO's license terms unless the source license explicitly grants relicensing rights.

### 11.5 Derivative works via linking

Because the Linker (`EXPERIENCE_COMPILER.md` §5) can compose multiple source EIRs — each potentially under different licenses — into one derivative XO, the resulting package's `licensing/license.json` MUST express the **most restrictive applicable term per contributing provenance chain**, not a single flattened license; a Runtime enforcing licenses on a linked XO MUST be able to attribute a specific capability invocation back to which source's terms govern it, via the provenance chain preserved through linking (`EXPERIENCE_COMPILER.md` §2.3, §5.2).

### 11.6 Revenue sharing and royalties

The royalty graph is derived automatically from `provenance/contributors.json`'s ownership-share basis points (`EXPERIENCE_COMPILER.md` §2.3), rolled up transitively through any linking or forking operations. A Licensing Authority MUST expose a query interface — `royalty_graph(xo_ref) → ContributorShare[]` — sufficient for a Marketplace to compute payout without re-deriving provenance itself.

---

## 12. Benchmark Protocol

### 12.1 Portability requirement

A `BenchmarkSuite` MUST be a self-contained, model- and vendor-neutral artifact — executable by any conformant Benchmark Engine against any conformant Runtime+XO pairing, producing comparable `ScoreReport`s regardless of who authored the suite or who runs it. This is what makes benchmark claims independently falsifiable rather than a seller's assertion.

### 12.2 Format

A `BenchmarkSuite` (matching `evaluation/benchmark_suite.json`, itself generated per `EXPERIENCE_COMPILER.md` §7) consists of versioned, categorized `BenchmarkItem`s (input, expected-behavior specification, difficulty, and — per §7.4 — the EIR node reference(s) it was derived from, where applicable) grouped into the standard categories: Knowledge, Reasoning, Consistency, Safety, Domain Coverage, Edge Cases, Explainability.

### 12.3 Scoring

Scoring MUST be deterministic given identical inputs where the item type allows it (exact-match/structured items), and MUST use a declared, versioned rubric for items requiring graded judgment (open-ended reasoning items) — the rubric itself is a versioned artifact so that a `ScoreReport` can be reproduced and the *rubric*, not just the item, can be challenged (§13).

### 12.4 Validation of a benchmark suite itself

Before a `BenchmarkSuite` can be published/certified, a Validator MUST check: item-to-EIR-node traceability where claimed, absence of duplicate items masquerading as coverage, and category balance against the source XO's declared Capability set — this is the benchmark-integrity analog of §6's schema validation.

### 12.5 Challenge process

See §13 for the full Challenge Network; at the Benchmark Protocol level, any `ScoreReport` MUST carry enough structured detail (which items, which Runtime/Compiler versions, timestamp, signer) to be independently re-run and disputed.

### 12.6 Benchmark certification and independent verification

A `ScoreReport` MAY carry a certification signature from an independent Benchmark Engine operator distinct from the Publisher, analogous to a third-party audit; certified and self-reported scores MUST be visually and structurally distinguishable in any public leaderboard (§12.7) — the protocol requires the distinction to be preserved, not that certification be mandatory.

### 12.7 Public leaderboards

A Marketplace or independent leaderboard operator publishing aggregate rankings MUST disclose its ranking methodology, MUST link every ranking entry to its underlying `ScoreReport`(s), and MUST reflect Challenge Network outcomes (§13) that overturn a prior score within a bounded propagation window.

### 12.8 Enterprise and historical benchmarks

Enterprise deployments MAY run private `BenchmarkSuite`s never submitted to any public Registry (fully conformant, per §4's per-role conformance) and MAY additionally run public suites for comparison. Historical `ScoreReport`s are append-only and MUST remain queryable even after a newer report supersedes them, so capability regression/improvement over time is auditable.

### 12.9 Benchmark versioning and refresh

A `BenchmarkSuite` is versioned independently of the XO it evaluates (an XO may be re-scored against a newer suite version without recompiling). Runtime execution telemetry (§10.4) feeding back into benchmark refresh, per `EXPERIENCE_COMPILER.md` §10.1, MUST be attributable to the specific suite version used, so score trends are comparable across time only within compatible suite versions, and a version bump's effect on scores is distinguishable from a genuine capability change.

---

## 13. Challenge Network

### 13.1 Purpose

Any organization or individual — not only the Publisher or a Marketplace — MUST be able to submit evidence disputing a published `ScoreReport` or a `CompilerAttestation`/`RuntimeAttestation` claim. This is the mechanism that makes the Trust Model (§7) resistant to a Publisher grading its own homework.

### 13.2 Submission

A `Challenge` is a signed record referencing the disputed `ScoreReport`/attestation by its canonical identifier, containing the challenger's counter-evidence (an independently-run `ScoreReport` against the same `BenchmarkSuite` version, or a specific reproducible failure case), and the challenger's identity (§7.1) — anonymous challenges MAY be accepted by a given Challenge Network operator's policy but MUST be flagged as lower-trust in the public record.

### 13.3 Validation of a challenge

The Challenge Network MUST independently re-run the disputed benchmark item(s) (or verify the challenger's reproduction) via a Benchmark Engine distinct from the one that produced the original disputed score, before the challenge can affect public standing — a challenge is evidence-gated, not vote-gated.

### 13.4 Evidence and dispute resolution

Disputes that resolve unambiguously from re-run results (the disputed score does not reproduce) MUST update the affected `ScoreReport`'s public status to `challenged` and, upon confirmation, `overturned`, with both the original and challenge evidence permanently retained (§13.8). Disputes that do not resolve unambiguously (methodology disagreement, rubric ambiguity for graded items) escalate to arbitration under the governance process's dispute-resolution track (§19.7).

### 13.5 Rewards and reputation

The protocol does not mandate a specific economic reward mechanism for successful challenges (that is a Marketplace-level design choice), but does require that every conformant Challenge Network operator maintain a **public, append-only reputation record** per challenger identity — challenge success rate, challenge volume — so reputation is portable across whichever Marketplace or Registry a challenger interacts with, rather than siloed.

### 13.6 Fraud prevention

Both false original scores and false challenges are misconduct under this model; a challenger identity with a demonstrated pattern of bad-faith challenges (per the reputation record, §13.5) MAY be down-weighted by a given Challenge Network operator's policy, but its historical challenge record MUST remain retrievable — reputational consequences are a policy layer on top of an immutable evidentiary layer, not a deletion of the record.

### 13.7 Appeals

A Publisher whose `ScoreReport` is overturned, or a challenger whose challenge is rejected, MAY appeal to the governance dispute-resolution track (§19.7); an appeal MUST reference the specific evidentiary record it disputes and MUST NOT be resolvable by re-litigating outside the evidence already submitted, except where new evidence is introduced (in which case it is treated as a new Challenge, §13.2).

### 13.8 Historical records

Every `Challenge`, its evidence, its resolution, and its appeal history (if any) are permanent, content-addressed, and independently fetchable — deletion is never a valid resolution to a dispute under this protocol.

---

## 14. Security

### 14.1 Threat model

| Threat | Description | Primary mitigation |
|---|---|---|
| Supply chain attack | Compromise of a Compiler, source dependency, or signing key to inject malicious capability | §7.7 attestation chain; §7.5 revocation |
| Fake Experience Object | A package claiming an identity/publisher it does not hold | §5.1 global identity + §7.2 Publisher verification |
| Malicious compiler | A Compiler producing EIR that passes syntactic validation but encodes harmful/deceptive behavior | §6.6's required Validation stages; Challenge Network post-hoc detection (§13) |
| Malicious runtime | A Runtime that ignores bundled `SafetyPolicy`/`Constraint` components | §10.3 required-component enforcement; §7.3 Runtime attestation; reputation consequences via Challenge Network |
| Poisoned benchmark | A `BenchmarkSuite` engineered to make a specific XO look better/worse than it is | §12.4 suite-level validation; independent certification (§12.6); Challenge Network |
| Fake identity | An entity impersonating a Publisher/Organization | §7.1 IdP-issued identity + certificate chain verification |
| Compromised registry | A Registry serving tampered content | §9.2 mandatory content-hash re-verification on every fetch regardless of source trust |
| Replay attack | Re-serving a revoked or superseded package/attestation as current | §5.2 canonical references bind identity to specific content hash; §7.5 revocation timestamps |

### 14.2 Sandbox requirements

A conformant Runtime MUST execute any weights, code, or scripted extensions bundled in an XO (e.g., custom prompt-strategy logic, plugin-provided lowering targets) within an isolation boundary that prevents that content from accessing host resources beyond what the negotiated consumption set (§10.2) explicitly grants.

### 14.3 Zero-trust deployment posture

No component in this ecosystem is required to trust another by default. Every cross-component interaction defined in this document (Compiler→Registry, Registry→Runtime, Runtime→host application, any→Challenge Network) is defined with an explicit verification step (signature, content hash, or evidentiary re-run) rather than an implicit trust relationship — an implementation that trusts a peer without performing the specified verification is non-conformant regardless of how reputable that peer is believed to be.

---

## 15. Enterprise Standard

### 15.1 Air-gapped and offline operation

Every role required for Enterprise Conformance (Compiler, Runtime, Registry, Validator) MUST be operable with zero external network dependency, using a locally-configured Trust Anchor Set (§7.4) and locally-populated package store (§9.5), including full Compiler operation (private-source ingestion and compilation never leaving the enterprise boundary) and offline Validation.

### 15.2 Private registries and internal Experience Objects

Enterprise-internal XOs use a private namespace (§5.3) and are fully conformant without ever being listed on a public Registry; nothing in this protocol requires a private XO to ever leave the enterprise boundary, including for validation or benchmarking (§15.1).

### 15.3 Compliance

Enterprise Conformance Class implementations MUST support operation compatible with, at minimum: SOC 2, ISO 27001, HIPAA (for XOs processing protected health information), and GDPR (for XOs processing EU personal data) — concretely, this means: audit logging (§15.4), data residency controls (§15.6), and provenance-level data-handling annotations sufficient to demonstrate that source evidence subject to these regimes was processed and retained per applicable requirements. This protocol does not itself certify compliance; it provides the structural hooks (audit logs, residency controls, provenance) that a compliance audit relies on.

### 15.4 Audit logs

Every protocol-significant event (compilation, publication, load, capability invocation, license check, benchmark run, challenge) MUST be logged in an append-only, tamper-evident form at Enterprise Conformance — the same event types already required to be observable at Core conformance for correctness (§4.1's Compilation Graph, Compiler Trace, execution telemetry) are additionally required to be *retained and auditable* at this class.

### 15.5 RBAC and multi-tenancy

An Enterprise-class Registry or Runtime MUST support role-scoped access control over publish, install, and invoke operations, and MUST support tenant isolation such that one tenant's private XOs, telemetry, and audit logs are not accessible to another tenant sharing the same physical deployment, without that isolation depending on network segmentation alone.

### 15.6 Data residency

An Enterprise-class Registry, Compiler, or Runtime MUST support constraining where source evidence, EIR, package content, and telemetry are stored and processed, sufficient to satisfy a stated jurisdictional residency requirement, and MUST make that constraint machine-declarable (not merely a deployment convention) so it can be verified as part of a compliance audit.

---

## 16. Extension Framework

### 16.1 Extension points

This protocol defines three stable extension points, matching the compiler's own plugin surfaces (`EXPERIENCE_COMPILER.md` §12.1) and extending them to the protocol layer: **new EIR node/edge kinds** (§6.5's additive-MINOR rule), **new package components** (an XO manifest MAY declare a component type not in the baseline set in `SPECIFICATION.md`, marked `required: false` unless a governance-approved spec update promotes it), and **new capability-negotiation fields** (§10.2's model-family entries MAY carry vendor-specific negotiation hints).

### 16.2 Plugin standards and custom metadata

Vendor and community extensions MUST be namespaced (`x-<org>-<extension-name>` convention, mirroring HTTP and OCI vendor-extension conventions) to prevent collision with core protocol fields and with each other. A conformant implementation encountering an unrecognized namespaced field MUST ignore it per §6.6's forward-compatibility rule, never error.

### 16.3 Capability negotiation and feature discovery

Beyond §10.2's model-family negotiation, any implementation MAY expose a general feature-discovery response (which extension namespaces it understands) so that two independently-built implementations sharing a vendor extension can detect mutual support and use it, while remaining fully conformant with each other absent that extension.

### 16.4 Experimental proposals and deprecation

An extension MAY be proposed for promotion into the core protocol via the XOIP process (§19.3). Until ratified, it remains an `x-` namespaced extension; once ratified, it is assigned a stable core field name and the extension form is deprecated per §6.7's standard deprecation policy, with the migration explicitly documented in the ratifying XOIP.

---

## 17. Reference Implementations

### 17.1 Normative vs. informative

This document (the XO Protocol) is **normative**. `SPECIFICATION.md` (XO package format), `RUNTIME_ARCHITECTURE.md`, and `EXPERIENCE_COMPILER.md` are **informative reference architectures** — they demonstrate one conformant way to satisfy this protocol's requirements and SHOULD be consulted for implementation guidance, but a from-scratch implementation that satisfies this document's requirements through different internal architecture is equally conformant.

### 17.2 Reference implementation roster

A healthy ecosystem under this protocol has independently-maintained reference implementations for each role (§3) — Reference Compiler, Reference Runtime, Reference Registry, Reference Validator, Reference CLI, Reference SDK, Reference Marketplace — maintained under the governance process (§19.5) as a public good, primarily to (a) anchor the conformance test suite (§4.3) against something concrete and (b) lower the barrier to entry for new implementers. No reference implementation is granted any protocol-level privilege over a competing implementation.

---

## 18. Developer Experience Standard

### 18.1 CLI specification

A conformant CLI MUST provide, at minimum, commands mapping to: `compile` (invoke a Compiler), `validate` (invoke a Validator), `publish` (push to a Registry), `install` (fetch + verify + register with a local Runtime), `bench` (invoke a Benchmark Engine), `challenge` (submit to a Challenge Network), and `inspect` (render a package's manifest/provenance/benchmark history for human review) — command names are a convention, not a wire-format requirement, but the functional coverage is normative for CLI conformance.

### 18.2 SDK interfaces

An SDK MUST expose, per supported language, the client-side operations underlying §8 (Registry Protocol), §9 (Distribution Protocol), and §10.4 (Runtime embedding), with signing/verification (§7) handled transparently unless the caller explicitly requests raw access.

### 18.3 Project structure and package manager conventions

A conformant local project structure separates source evidence references, EIR build artifacts, and compiled output, mirroring the Compiler's own stage separation (`EXPERIENCE_COMPILER.md` §1.1) so that intermediate EIR can be inspected, diffed, and incrementally rebuilt (`EXPERIENCE_COMPILER.md` §8.2) from a local developer workflow, not only from a hosted compilation service.

### 18.4 Testing, validation tools, and debugging

Local, offline Validator and Benchmark Engine invocations MUST be available (not solely as hosted services) so a developer can iterate without publishing. Debugging tooling SHOULD expose the Compiler Trace and Compilation Graph (`EXPERIENCE_COMPILER.md` §11) in human-readable form.

### 18.5 Dependency management, package signing, local/dev registries

Dependency resolution (§8.4) MUST be available against a local or private Registry for pre-publish testing. Package signing (§7.2) MUST be performable against a locally-held development key distinct from a production Publisher key, with tooling that makes it structurally difficult to accidentally publish a dev-signed package as production (§3.5's local/production distinction).

### 18.6 Developer sandbox

A conformant developer environment MUST support a fully local Compiler→Registry→Runtime loop (install a locally-compiled, locally-signed XO into a locally-running Runtime) with zero network dependency, so the entire ecosystem's core loop is learnable and testable without any account, key issuance from a public IdP, or network access.

---

## 19. Governance

### 19.1 Ownership of the protocol

This protocol is not owned by any single company. It is maintained by a **Protocol Stewardship Body** — a governance entity (which MAY begin as a single founding organization's open-governance commitment and MUST transition to a multi-stakeholder body, per §19.8, as the ecosystem grows) whose sole authority is over the *text of this document* and the *conformance test suite* (§4.3), not over any implementation, Registry, or Marketplace built against it.

### 19.2 Change proposal process — XO Improvement Proposals (XOIPs)

All normative changes to this protocol — new sections, modified requirements, new extension promotions (§16.4) — proceed through **XO Improvement Proposals (XOIPs)**, modeled directly on Python PEPs, Ethereum EIPs, and Rust RFCs:

| Stage | Description |
|---|---|
| Draft | Author submits a numbered XOIP with problem statement, proposed normative text, and backward/forward-compatibility analysis (§6.6) |
| Discussion | Open public comment period of a governance-published minimum duration |
| Review | Protocol Stewardship Body technical review against §19.4's approval criteria |
| Last Call | Final comment window; substantive objections MUST be addressed or the XOIP returns to Draft |
| Final | Ratified; assigned to a specific upcoming protocol version per §19.3's classification |
| Rejected / Withdrawn / Superseded | Terminal non-adopted states, retained in the public XOIP archive permanently |

### 19.3 Classification and breaking-change approval

Every XOIP is classified as **Additive** (safe as a MINOR bump, per §6.6), **Breaking** (requires a MAJOR bump), or **Process** (governance/meta changes, no version bump). Breaking XOIPs require a higher approval bar than Additive ones — a supermajority of the Protocol Stewardship Body plus a published minimum implementer-adoption signal (a minimum number of independent Extended/Enterprise-conformant implementations committing to support it) before Final status, specifically to prevent a breaking change from fragmenting the ecosystem it's meant to unify.

### 19.4 Ratification criteria

An XOIP MUST NOT reach Final status unless it: preserves every existing conformance class's ability to be satisfied (or provides an explicit, XOIP-documented migration, per §6.7's deprecation policy), includes conformance test suite additions/updates, and — for Breaking XOIPs — includes a stated deprecation timeline for whatever it replaces.

### 19.5 Reference implementation maintenance

Reference implementations (§17.2) are maintained by governance-designated maintainer teams, which MAY but need not be the Protocol Stewardship Body itself; maintainership is a service role, not a source of protocol authority — a reference implementation maintainer has no special standing in the XOIP process beyond what any other participant has.

### 19.6 Public namespace and Trust Anchor Set governance

The governance process additionally maintains the shared, publicly-recognized namespace registry (§5.3) and the shared conventional Trust Anchor Set (§7.4) as living, XOIP-amendable artifacts — additions here (a new publicly recognized IdP root, a new top-level namespace grant policy) follow the same process as any other Additive XOIP.

### 19.7 Dispute resolution

Disputes not resolved by the Challenge Network's evidentiary process (§13.4) — genuine methodology disagreements, identity/ownership transfer disputes (§5.4), or appeals (§13.7) — escalate to a standing **Arbitration Panel** constituted by the Protocol Stewardship Body from independent, non-conflicted members. Arbitration decisions are published in full (evidence, reasoning, outcome) as permanent public record, consistent with §13.8's retention requirement.

### 19.8 Path to decentralized governance

The Protocol Stewardship Body MUST publish, and periodically update, a concrete plan for expanding its own membership beyond any single founding organization as adoption milestones are met (independent conformant implementations per role, independent Trust Authorities, geographic/sectoral diversity of implementers) — this is a standing governance obligation, not a one-time commitment, and is itself amendable only via a Process-classified XOIP requiring the highest approval bar defined in §19.3.

---

## 20. Ecosystem Roadmap

### 20.1 Principle: extend, never break

Every anticipated evolution below is designed to land as an Additive XOIP (§19.3) wherever possible — a new EIR node kind, a new package component, a new negotiation field — precisely because §6.6's forward-compatibility rule guarantees that existing conformant implementations keep working, unaware of and unaffected by capability they don't yet implement, while new implementations adopt the extension immediately.

### 20.2 Anticipated directions (informative, non-normative)

| Direction | Likely landing point in this protocol |
|---|---|
| AI-native capabilities (capabilities whose primary consumer is another AI system, not a human-facing application) | New capability-negotiation model-family entries (§10.2); no structural change required |
| Agent-to-agent capability exchange | Extension of the Runtime embedding contract (§10.4) to support Runtime-to-Runtime capability invocation as a peer relationship, likely its own XOIP track |
| Deeper capability composition (beyond the Linker's current `composes_into`, `EXPERIENCE_COMPILER.md` §5.5) | New EIR edge kinds (§6.5, additive) |
| Federated learning as a source adapter class | New Compiler front-end adapter family (`EXPERIENCE_COMPILER.md` §2.2); protocol-level impact limited to provenance schema fields for federated-source attribution |
| Edge/constrained deployment | Extension of §9.3's delta/streaming distribution and the Compiler's Compression for Deployment pass; a new Conformance Class (§4.1) tier ("Edge") is a plausible future XOIP rather than a change to existing classes |
| Autonomous, continuous benchmarking | Extension of §12.9's refresh model from periodic to continuous; primarily a Benchmark Engine implementation concern, minimal protocol change |
| Fully distributed/DHT-style registries | A new Registry Protocol federation mode (§8.5), additive to the existing pull-based sync model |
| New EIR major versions as reasoning representations evolve | Governed entirely by §6.5's migration-mapping requirement — this is the mechanism, already specified, that lets EIR itself evolve without stranding existing XOs |

### 20.3 What must never change

Three guarantees are treated as permanent invariants of this protocol, changeable only through the highest-bar Breaking-XOIP process (§19.3) and never silently: the global uniqueness and content-addressing guarantee of XO identity (§5), the requirement that safety-relevant components fail closed rather than silently degrade (§10.3), and the requirement that trust claims be independently verifiable rather than asserted (§7, §13). Every anticipated extension in §20.2 is designed to be addable without touching any of these three.

---

## Appendix A. Document Cross-Reference

| This document's section | Reference implementation detail |
|---|---|
| §5–6, §9 (XO identity, versioning, distribution) | `SPECIFICATION.md` |
| §3.2, §10 (Runtime role, interoperability) | `RUNTIME_ARCHITECTURE.md` |
| §3.1, §6.5 (Compiler role, EIR) | `EXPERIENCE_COMPILER.md` |

## Appendix B. Requirement Keyword Summary

This document follows RFC 2119. Implementers are reminded that imperatives (MUST/MUST NOT) are conformance-blocking; recommendations (SHOULD/SHOULD NOT) require documented justification to deviate from; permissions (MAY/OPTIONAL) impose no obligation either way.
