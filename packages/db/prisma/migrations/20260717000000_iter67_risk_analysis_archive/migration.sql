-- =============================================================================
-- iter67: Revisionssichere Archivierung von Subsumtionen (GoBD/§ 147 AO).
--
-- archived_at: gesetzt, sobald ein self-contained Snapshot (Sachverhalt +
--   Markierungen + Hash) gzip im GoBD-Bucket (Object-Lock COMPLIANCE) liegt.
--   Archivierte Analysen sind schreibgeschützt (Mutationen werden abgelehnt).
-- archive_bucket/archive_key: Referenz auf den unveränderlichen Snapshot.
--
-- Additiv/nullable → kein Backfill. RLS-Policy aus iter60 greift unverändert.
-- =============================================================================

ALTER TABLE "risk_analysis"
  ADD COLUMN "archived_at" TIMESTAMPTZ(6),
  ADD COLUMN "archive_bucket" TEXT,
  ADD COLUMN "archive_key" TEXT;
