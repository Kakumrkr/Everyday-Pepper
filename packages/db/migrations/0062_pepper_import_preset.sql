-- Pepper's own export as an import preset (S51, ADR-0053): its clients.csv and visits.csv
-- import back as "Pepper" files, sharing one system so their client ids meet.
ALTER TABLE "import_batches" DROP CONSTRAINT "import_batches_preset_known";--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_preset_known" CHECK ("import_batches"."preset" IS NULL OR "import_batches"."preset" IN ('square', 'booksy', 'vagaro', 'glossgenius', 'fresha', 'pepper'));