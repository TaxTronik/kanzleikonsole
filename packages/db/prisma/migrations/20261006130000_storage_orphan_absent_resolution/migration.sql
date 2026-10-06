-- DOC-UPLOAD-JOURNAL-001 / DOC-OBJECT-LOCK-001 (storage_orphan und
-- storage_orphan_resolution aus 20260823120000_workflow_consistency_backstops).
--
-- Review-Finding K-06. Upload-Pfade journalisieren ihre Speicherabsicht kuenftig
-- VOR dem Object-Write im Storage-Orphan-Journal. Bricht ein Upload vor dem
-- PUT ab oder scheitert der PUT, existiert unter dem festen Intent-Schluessel
-- nachweislich kein Objekt. Der Cleanup-Worker schliesst eine solche Absicht
-- mit dem neuen Ergebnis ABSENT ab, statt sie dauerhaft als Fehler zu fuehren.
--
-- Der neue Enum-Wert steht bewusst in einer eigenen Migration: PostgreSQL darf
-- ihn erst nach dem Commit in Constraints und Abfragen verwenden
-- (20261006130100_storage_upload_intent).
BEGIN;

ALTER TYPE public.storage_orphan_resolution
  ADD VALUE IF NOT EXISTS 'ABSENT';

COMMIT;
