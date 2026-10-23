-- pgvector for the memory's episode embeddings (Phase 7, ADR-0034). The extension is not
-- marked trusted, so the migration role must be allowed to create it (the Compose and CI
-- superuser; on a managed host, its admin role, or an administrator creates it beforehand).
CREATE EXTENSION IF NOT EXISTS vector;
