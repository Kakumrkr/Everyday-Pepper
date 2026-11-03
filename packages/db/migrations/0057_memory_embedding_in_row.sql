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
-- makes a fresh value; an unchanged one would keep its TOAST pointer); the values are unchanged.
-- The table forces RLS (0039), whose policies see no row outside tenant context, so a migration
-- owner that is not a superuser (a managed database's) would update nothing: RLS is lifted for
-- the owner only while the rewrite runs, inside the migrations' one transaction. One statement
-- is fine at this size (no pilot data yet; at most 5,000 episodes a member).
ALTER TABLE "memory_episodes" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "memory_episodes" SET "embedding" = "embedding"::text::vector;
--> statement-breakpoint
ALTER TABLE "memory_episodes" FORCE ROW LEVEL SECURITY;
