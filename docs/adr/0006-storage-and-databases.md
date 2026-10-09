# ADR 0006: Postgres + Redis (+ optional Neo4j), local-fs/in-memory reference implementations for now

## Status
Accepted

## Context
Three storage-shaped needs exist across the eventual platform: (1) blob
storage for XO package components, (2) relational storage for the
registry (published packages, benchmark runs, license/royalty records —
data with real foreign-key relationships), and (3) graph storage for a
knowledge graph that may, for some XOs, outgrow a single process's
memory.

## Decision
- **Blob storage**: `BlobStore` interface (`packages/storage`), backed
  today by `LocalFsBlobStore`. Production target: S3/GCS/R2-compatible
  object storage behind the same interface.
- **Relational storage**: Postgres, provisioned in `docker-compose.yml`,
  not yet consumed by any code (no registry implementation exists yet).
- **Graph storage**: `GraphStore` interface (`packages/graph-engine`),
  backed today by `InMemoryGraphStore`. Neo4j is provisioned but
  profiled out of the default `docker compose up` (`--profile graph`)
  since nothing consumes it yet.
- **Caching/queueing**: Redis, provisioned, not yet consumed.

## Alternatives considered
- **MongoDB instead of Postgres**: the registry's data (a benchmark run
  references a package; a license references a package and sums royalty
  splits to exactly 10000 bps per `SPECIFICATION.md` §4) is relational
  with real integrity constraints a document store enforces awkwardly.
  Postgres also supports `pgvector` as a low-friction first vector-search
  option if/when `runtime-core`'s `Retriever` needs semantic search,
  without provisioning a fourth database.
- **A dedicated graph database (Neo4j) from day one, no in-memory
  option**: rejected as the *only* option — most individual XOs'
  knowledge graphs (per `PACKAGE_README.md`'s worked example: 8 document
  types, 22 clause types) comfortably fit in memory. Keeping
  `GraphStore` as an interface with an in-memory default avoids forcing
  every local dev setup and every test run through a real graph database.
- **A vector database now (Qdrant/Pinecone/etc.)**: deferred — nothing in
  this module does retrieval yet; adding one before `Retriever` has a
  real implementation would be guessing at index/embedding-dimension
  requirements with no workload to validate against.

## Consequences
- `docker-compose.yml` provisions Postgres/Redis unconditionally and
  Neo4j behind a profile flag, so the next module (registry
  implementation) has real backing services to develop against
  immediately, without this module needing to write any SQL/Cypher
  itself.
- Swapping `LocalFsBlobStore` -> S3 or `InMemoryGraphStore` -> Neo4j later
  is "write a new class implementing the existing interface," not a
  call-site migration, by construction.
