-- Episode embeddings stored in the row, not in TOAST (S47.3).
--
-- Episode search is exact (no index, playbook D-4), so it reads every embedding the member may
-- see. A 1,536-dimension vector is about 6 KB, over TOAST's 2 KB threshold, so Postgres kept each
-- one out of line and every search fetched and reassembled 5,000 of them: 2.5x the buffer reads
-- (16.5 ms against 5.7 ms for the bare query at the per-member cap) and the latency gate's p95
-- miss on CI's 2-CPU runner. PLAIN keeps the vector in the heap row; the row still fits a page
-- because summary, client_ids and fact_ids can still move out of line (largest row about 6.5 KB).
-- A model with more than about 1,900 dimensions would not fit and must revisit this.
ALTER TABLE "memory_episodes" ALTER COLUMN "embedding" SET STORAGE PLAIN;
--> statement-breakpoint
-- Rewrite rows written before this migration so their vectors move into the row too (the cast
-- makes a fresh value; an unchanged one would keep its TOAST pointer). Migrations run as the
-- database owner, outside tenant context; the vector values are unchanged.
UPDATE "memory_episodes" SET "embedding" = "embedding"::text::vector;
