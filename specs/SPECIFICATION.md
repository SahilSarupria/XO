# XO Package Format Specification v1.0
### Experience Objects: A Portable Standard for AI Professional Capability

---

## 0. Design Thesis

An **Experience Object (XO)** is a signed, versioned, model-agnostic package that transfers *professional capability* — not raw text, not a single fine-tune — into any host AI system. A host loads only the components it can consume and ignores the rest. Trust is not asserted by the seller; it is measured by a benchmark and challenge system anchored on a blockchain ledger, and it is re-measurable by anyone at any time.

Three properties make this a platform rather than a content library:

1. **Heterogeneous consumption** — one package, many model families, each using a different subset of components (LoRA vs. knowledge graph vs. reasoning traces vs. system prompts).
2. **Falsifiable trust** — every capability claim is a benchmark claim, and every benchmark claim is challengeable, re-runnable, and immutable once settled.
3. **Composable economics** — royalties, ownership, and provenance are enforced at the protocol layer, not by marketplace policy, so multi-party creation (author + reviewer + dataset contributor) is a first-class case, not an afterthought.

---

## 1. The XO Package Format

### 1.1 Package layout

An XO is distributed as a signed archive (`.xo`), which is a content-addressed tarball (zstd-compressed) with a deterministic layout:

```
my-xo-1.4.0.xo
├── manifest.json              # required — identity, compatibility, component index
├── metadata.json               # required — domain description, scope, limitations
├── knowledge/
│   ├── graph.json               # knowledge graph (nodes, edges, ontology)
│   └── sources.json             # provenance of underlying source material
├── memory/
│   └── long_term_graph.json     # episodic/semantic memory graph (optional)
├── reasoning/
│   ├── decision_trees.json
│   ├── reasoning_traces.jsonl    # one trace per line, streamable
│   └── case_library.json
├── prompting/
│   └── strategies.json           # system prompts, workflows, tool-call templates
├── weights/                     # optional
│   ├── lora/                     # adapter weights per base-model family
│   └── finetune/                 # full/partial fine-tuned weight deltas
├── evaluation/
│   ├── benchmark_suite.json
│   └── benchmark_history.json    # append-only, mirrors on-chain record
├── safety/
│   └── rules.json
├── licensing/
│   └── license.json
├── provenance/
│   ├── contributors.json
│   └── version_history.json
├── signatures/
│   └── signatures.json           # detached signatures over every file's hash
└── CHANGELOG.md
```

Every file above is individually content-hashed (SHA-256). `manifest.json` stores a Merkle root over all component hashes, which is what actually gets committed on-chain — not the package contents themselves (see §5).

### 1.2 Manifest schema (authoritative)

```json
{
  "xo_id": "xo_corp_contract_lawyer",
  "name": "Corporate Contract & Commercial Lawyer",
  "version": "1.4.0",
  "spec_version": "1.0",
  "creator": {
    "id": "did:xo:0x9f3a...",
    "display_name": "Lex Machina Labs"
  },
  "compatibility": {
    "model_families": [
      {"family": "gpt", "min_capability": ["chat", "tool_use"], "consumes": ["knowledge_graph", "reasoning_traces", "prompt_strategies", "long_term_memory_graph"]},
      {"family": "claude", "min_capability": ["chat", "tool_use", "long_context"], "consumes": ["knowledge_graph", "reasoning_traces", "case_library", "prompt_strategies"]},
      {"family": "gemini", "min_capability": ["chat"], "consumes": ["knowledge_graph", "decision_trees", "lora"]},
      {"family": "llama", "min_capability": ["chat"], "consumes": ["knowledge_graph", "lora", "finetune"]},
      {"family": "generic", "min_capability": ["chat"], "consumes": ["knowledge_graph", "prompt_strategies"]}
    ],
    "fallback_policy": "degrade_gracefully"
  },
  "components": {
    "knowledge_graph": {"path": "knowledge/graph.json", "hash": "sha256:...", "required": false},
    "long_term_memory_graph": {"path": "memory/long_term_graph.json", "hash": "sha256:...", "required": false},
    "decision_trees": {"path": "reasoning/decision_trees.json", "hash": "sha256:...", "required": false},
    "reasoning_traces": {"path": "reasoning/reasoning_traces.jsonl", "hash": "sha256:...", "required": false},
    "case_library": {"path": "reasoning/case_library.json", "hash": "sha256:...", "required": false},
    "prompt_strategies": {"path": "prompting/strategies.json", "hash": "sha256:...", "required": false},
    "lora": {"path": "weights/lora/", "hash": "sha256:...", "required": false},
    "finetune": {"path": "weights/finetune/", "hash": "sha256:...", "required": false},
    "safety_rules": {"path": "safety/rules.json", "hash": "sha256:...", "required": true},
    "benchmark_suite": {"path": "evaluation/benchmark_suite.json", "hash": "sha256:...", "required": true}
  },
  "merkle_root": "sha256:...",
  "license_ref": "licensing/license.json",
  "created_at": "2026-02-11T00:00:00Z",
  "updated_at": "2026-07-20T00:00:00Z"
}
```

`required: true` components must be present and validate, or the package fails to install. `safety_rules` and `benchmark_suite` are required for every XO admitted to the public marketplace — this is the one policy the platform hard-enforces at the format level.

---

## 2. Loading & Compatibility Layer

### 2.1 Load sequence

```
1. Fetch package → verify Merkle root against on-chain record
2. Verify signature(s) against creator DID + any co-signers (reviewers)
3. Parse manifest → determine host model family
4. Intersect host's declared capabilities with manifest.compatibility
5. Resolve component set = components the host CAN consume
6. For each resolved component, run its type-specific loader:
     - knowledge_graph  → graph store adapter (in-context subgraph retrieval
                            or external graph DB, host's choice)
     - reasoning_traces → few-shot exemplar bank + optional distillation target
     - decision_trees   → deterministic tool the host can call, OR serialized
                            into a reasoning scaffold prompt
     - prompt_strategies→ injected as system-prompt fragments / tool schemas
     - lora / finetune  → applied at inference layer if host supports weight
                            loading; otherwise skipped
7. Construct unified "capability layer" = single interface object exposed to
   the host session (see §2.3)
8. Emit a load_receipt (signed) recording which components were actually
   used — this feeds the benchmark and royalty attribution system
```

Unsupported components are skipped, not errored — this is what makes the format model-agnostic. The `load_receipt` is important: royalties and reputation are partly a function of *actual utilized capability*, not just "installed," so partial consumption by weaker hosts doesn't overpay creators relative to the value delivered.

### 2.2 Compatibility levels

| Level | Meaning |
|---|---|
| L0 | Prompt-only (works with any chat model — lowest common denominator) |
| L1 | + Knowledge graph retrieval (requires tool-use or RAG-capable host) |
| L2 | + Reasoning traces as in-context exemplars (requires long-context) |
| L3 | + Decision trees as callable tools (requires function/tool calling) |
| L4 | + LoRA / weight-level adaptation (requires host-side fine-tuning support) |

A given XO advertises the max level it *offers*; a given host achieves whatever level its capabilities intersect with. This number is shown in the marketplace listing per host ("This XO reaches L3 on Claude, L1 on generic chat models").

### 2.3 The Capability Layer interface

This is the only thing host integrations need to implement — a thin adapter, not a rewrite of the host's stack:

```typescript
interface CapabilityLayer {
  systemPromptFragments(): string[];
  toolDefinitions(): ToolSchema[];               // decision trees, calculators, lookups
  retrieve(query: string, k: number): GraphNode[]; // knowledge graph subgraph retrieval
  exemplars(taskType: string, k: number): ReasoningTrace[];
  weightsPatch(): WeightsArtifact | null;          // LoRA/finetune, or null
  safetyGate(input: SessionContext): SafetyDecision;
  emitLoadReceipt(): SignedReceipt;
}
```

Any host — a GPT-based agent framework, a Claude tool-use loop, a local Llama deployment — implements a small binding against this interface once, then can consume *any* XO in the marketplace.

---

## 3. Benchmark & Trust Framework

### 3.1 Why measured reputation instead of reviews

Star ratings are gameable and don't compose across buyers with different needs. XO reputation is instead a vector of **task-grounded scores**, each backed by a reproducible benchmark run with a public methodology and a signed result.

### 3.2 Score vector

```json
{
  "overall_score": 91.2,
  "knowledge_score": 93.5,
  "reasoning_score": 89.0,
  "accuracy": 92.1,
  "consistency": 88.7,
  "safety": 97.4,
  "hallucination_rate": 2.1,
  "enterprise_usage": 340,
  "downloads": 18402,
  "active_installations": 5122,
  "last_verification": "2026-07-18T00:00:00Z",
  "community_rating": 4.6,
  "expert_rating": 4.8
}
```

Scores are computed per-model-family too (a Corporate Lawyer XO may score 93 on Claude and 81 on a small open model), because "how good is this XO" is not a single number independent of the host running it.

### 3.3 Benchmark methodology object

Every benchmark run stores, immutably:

```json
{
  "benchmark_id": "bm_2026_07_18_0091",
  "xo_id": "xo_corp_contract_lawyer",
  "xo_version": "1.4.0",
  "host_model": "claude-sonnet-5",
  "task_set_hash": "sha256:...",
  "n_tasks": 500,
  "scorer": "xo-eval-harness-v2",
  "results": {"accuracy": 0.921, "hallucination_rate": 0.021, "...": "..."},
  "runner": "did:xo:platform-verifier-01",
  "signature": "..."
}
```

The `task_set_hash` lets anyone verify the exact task set used without necessarily disclosing it publicly (private eval sets are hashed and revealed only during challenge disputes, to prevent overfitting to a known public set).

### 3.4 Challenge system (protocol-level dispute resolution)

```
1. Challenger stakes a bond and submits an alternative task set
   (e.g. 500 held-out contracts) + declared expected methodology.
2. Platform runs BOTH the XO's original claimed benchmark and the
   challenger's task set, on the same host model, under the same harness.
3. If the delta between claimed and re-measured score exceeds a
   tolerance threshold (e.g. 3 points):
      → challenge succeeds
      → score is permanently revised on-chain
      → creator's bond (posted at listing time) is partially slashed
        and paid to challenger
      → benchmark_history retains BOTH results, timestamped
4. If within tolerance or the challenger's task set is found invalid
   (e.g. mislabeled ground truth, out-of-domain tasks):
      → challenge rejected
      → challenger's bond is forfeited to a platform integrity pool
```

This makes false "96% accuracy" marketing claims economically costly to make and economically rewarding to disprove — the core anti-fraud mechanism of the marketplace.

---

## 4. Licensing & Royalties

### 4.1 License object

```json
{
  "license_type": "commercial-per-seat",
  "terms": {
    "seats": "unlimited-org",
    "redistribution": false,
    "derivative_works": "allowed-with-attribution",
    "training_on_outputs": "prohibited",
    "jurisdiction_restrictions": ["US", "UK", "EU"]
  },
  "royalty_split": [
    {"role": "primary_author", "recipient": "did:xo:...", "bps": 6000},
    {"role": "co_author", "recipient": "did:xo:...", "bps": 2500},
    {"role": "reviewer", "recipient": "did:xo:...", "bps": 1000},
    {"role": "dataset_contributor", "recipient": "did:xo:...", "bps": 500}
  ]
}
```

`bps` = basis points, must sum to 10000. Enforced by the settlement contract at sale time (see §5.3) — not by off-chain bookkeeping.

---

## 5. Blockchain Architecture

**Explicitly not used for**: inference, hosting model weights, storing knowledge graphs on-chain, or being a compute layer of any kind. On-chain footprint is intentionally minimal.

**Used for**: provenance, ownership, tokenized identity, immutable benchmark/version history, and royalty settlement — the things that must be tamper-evident and don't need high throughput.

### 5.1 On-chain object: the XO token

An XO is minted as a non-fungible token whose metadata pointer resolves to:

```json
{
  "xo_id": "xo_corp_contract_lawyer",
  "manifest_merkle_root": "sha256:...",
  "current_version": "1.4.0",
  "creator": "did:xo:...",
  "license_ref": "ipfs://... or arweave://...",
  "version_history_ref": "...",
  "benchmark_history_ref": "..."
}
```

Package bytes themselves live off-chain (content-addressed storage — see §7). The chain stores hashes and pointers, never blobs.

### 5.2 Chain choice & throughput

Recommend an L2 (e.g. an EVM-compatible rollup) rather than L1 mainnet: benchmark writes and micro-royalty settlements are frequent and low-value individually, and rollup fees make per-download royalty distribution economically viable. The spec is chain-agnostic — the only hard requirement is: (a) smart-contract support for programmable royalty splits, (b) sub-cent transaction costs, (c) finality fast enough for interactive "buy → install" UX (<10s).

### 5.3 Settlement contract (pseudocode)

```solidity
function purchase(uint256 xoTokenId) external payable {
    License memory lic = licenses[xoTokenId];
    require(msg.value >= lic.price, "insufficient payment");
    RoyaltySplit[] memory splits = royalties[xoTokenId];
    for (uint i = 0; i < splits.length; i++) {
        uint256 cut = msg.value * splits[i].bps / 10000;
        payable(splits[i].recipient).transfer(cut);
    }
    installations[xoTokenId][msg.sender] = true;
    emit Purchased(xoTokenId, msg.sender, msg.value);
}

function recordBenchmark(uint256 xoTokenId, bytes32 resultHash, address runner, bytes memory sig) external {
    require(verifiedRunner[runner], "unverified benchmark runner");
    benchmarkHistory[xoTokenId].push(BenchmarkRecord(resultHash, runner, block.timestamp, sig));
    emit BenchmarkRecorded(xoTokenId, resultHash);
}

function fileChallenge(uint256 xoTokenId, bytes32 taskSetHash) external payable {
    require(msg.value >= challengeBond, "bond required");
    challenges[xoTokenId].push(Challenge(msg.sender, taskSetHash, block.timestamp, ChallengeStatus.Pending));
}
```

### 5.4 Version history as a chain

Each version commit is a signed, chained record (`prev_hash` links to the prior version), so the full lineage of an XO — including every benchmark delta at every version — is independently reconstructable and tamper-evident, functioning like a domain-specific append-only ledger even before considering the smart contract layer.

---

## 6. APIs

REST + GraphQL, versioned at `/v1/`. Representative surface:

```
POST   /v1/xo                          Create/upload a new XO package
GET    /v1/xo/{id}                     Fetch manifest + metadata + scores
GET    /v1/xo/{id}/versions            Version history
POST   /v1/xo/{id}/versions            Publish new version
GET    /v1/xo/{id}/benchmarks          Benchmark history
POST   /v1/xo/{id}/benchmarks/run      Trigger a verifier run
POST   /v1/xo/{id}/challenge           File a challenge
POST   /v1/xo/{id}/purchase            Purchase / license
POST   /v1/xo/{id}/install             Record installation + fetch load bundle
GET    /v1/search?q=...                Semantic capability search
GET    /v1/search/embed?text=...       Raw embedding for client-side matching
POST   /v1/orgs/{org}/xo               Publish private/internal XO
GET    /v1/orgs/{org}/audit-log        Enterprise audit trail
POST   /v1/loader/resolve              Given host capabilities + xo_id → resolved component set
```

`POST /v1/loader/resolve` is the key integration point for third-party AI platforms — it lets any host determine, before installing, exactly which components it will actually be able to use and at what compatibility level (§2.2).

GraphQL mirrors this for composite queries (e.g. "top 10 XOs in tax law with hallucination_rate < 3% compatible with Llama").

---

## 7. Storage Strategy

| Data | Storage | Rationale |
|---|---|---|
| Package bytes (.xo archives) | Content-addressed object storage (S3-compatible) + IPFS/Arweave pinning for censorship-resistant redundancy | Large, immutable once versioned, needs cheap high-throughput reads |
| Knowledge graphs | Graph DB (e.g. Neo4j) for the "live" queryable copy; JSON export inside package for portability | Marketplace-side semantic search & preview needs a real graph engine; the package itself must remain self-contained |
| Reasoning traces / case library | Object storage, JSONL, chunked for streaming into long-context hosts | Large, append-friendly, sequential access pattern |
| Vector embeddings (search) | Dedicated vector index (e.g. HNSW-based store) | Semantic search over XO descriptions + capability graphs |
| Manifests, scores, licenses | Relational store (source of truth for the marketplace app) mirrored to chain hashes | Needs transactional queries, joins, filtering |
| On-chain | Hashes, pointers, royalty logic, benchmark commitments only | Minimize chain bloat and gas cost |

---

## 8. Security Model

- **Package integrity**: Merkle root verification on every install; any single byte change anywhere in the package invalidates the signature.
- **Signing**: creator DID-based signatures (public-key); enterprise orgs can require multi-sig (author + internal reviewer) before an XO is installable inside their tenant.
- **Sandboxed evaluation**: benchmark runners execute in isolated environments with no network egress beyond the eval harness, so a malicious XO's prompt-injection payloads can't be used to fake benchmark results by attacking the runner itself.
- **Weight artifact scanning**: LoRA/finetune blobs are scanned for known malicious patterns (e.g. trigger-based backdoors) before listing; flagged artifacts are quarantined pending manual review.
- **Prompt-injection isolation**: knowledge graph and case library content injected into a host's context is namespaced and marked as untrusted-content-provenance so host models can apply their own injection defenses rather than treating XO content as system-level instruction by default.
- **Access control**: enterprise private XOs use RBAC scoped per-org, per-department, per-role; audit log is append-only and exportable for compliance.
- **Key compromise recovery**: creator identity supports key rotation with a challenge-period timelock, so a compromised key can't be used to silently republish malicious versions of a trusted XO without a delay that gives the community time to flag it.

---

## 9. Semantic Search

Search is intent-based, not keyword-based:

```
Query: "I need an expert in mergers and acquisitions"
   ↓ embed query
   ↓ compare against XO capability embeddings (built from metadata +
     knowledge graph topic coverage + benchmark task categories,
     not just marketing description)
   ↓ re-rank by: relevance × trust_score × host_compatibility
   ↓ return ranked XOs with per-host compatibility level (§2.2) annotated
```

Capability embeddings are computed from *structured* signal (graph topic coverage, benchmark task taxonomy) blended with description text, specifically to resist search-result gaming via keyword stuffing in free-text fields.

---

## 10. Enterprise Features

- Private marketplace instance per org (own namespace, own approval workflow)
- Department-scoped XOs (e.g. Legal-only, Finance-only visibility)
- Version approval gates (an internal reviewer must sign off before a new XO version is usable org-wide)
- RBAC: publisher / reviewer / installer / auditor roles
- Full audit log: who installed what version, when, and what load_receipt was emitted
- Compliance exports (SOC2 / ISO-style evidence: signed benchmark history, safety rule set, license terms)
- Enterprise licensing: seat-based, usage-based, or flat org-wide, settled the same way as consumer purchases but billed via invoicing rather than on-chain micropayment if preferred

---

## 11. Extensibility Roadmap

| Phase | Focus |
|---|---|
| **v1.0 (this spec)** | Package format, loader, single-chain trust layer, benchmark/challenge system, core APIs |
| **v1.1** | Multi-XO composition — installing several XOs simultaneously with conflict resolution (e.g. Corporate Lawyer XO + Tax Consultant XO overlapping on contract tax clauses) |
| **v1.2** | Federated benchmark runners — allow trusted third parties (universities, professional bodies e.g. bar associations) to become verified runners, diversifying who can attest to scores |
| **v1.3** | On-device / local-model loaders for edge deployment (compatibility level for quantized local models) |
| **v1.4** | XO composition marketplaces — "bundles" (e.g. a Startup Legal Stack bundle) with bundle-level royalty splitting across constituent XOs |
| **v2.0** | Cross-chain portability of XO tokens; standardized inter-marketplace protocol so a competing marketplace can verify/import XOs without re-litigating trust from zero |

---

## 12. Non-Goals (explicit)

- The platform does not execute inference itself — it is not a hosting provider for the AI models that consume XOs.
- The blockchain layer is not a compute or storage layer.
- The platform does not itself certify legal, medical, or financial advice as correct for a specific real-world matter — benchmark scores measure task performance against held-out test sets, not licensure. See the flagship XO's `safety/rules.json` for how this is handled at the package level.
