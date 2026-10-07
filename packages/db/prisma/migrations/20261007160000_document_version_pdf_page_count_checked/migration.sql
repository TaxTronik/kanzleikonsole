-- GWG-IDENTIFICATION-EVIDENCE-001 / GWG-SELF-ONBOARDING-001 (Ausweisausschnitte
-- gegen die gebundene Originalversion prüfen; Folgearbeit zu 20261005140000).
--
-- Review-Finding P-13. Die Seitenzahl einer PDF-Ausweisquelle wird beim Upload
-- gespeichert (document_version.pdf_page_count). Für Versionen ohne Wert
-- (Altbestand vor 20261005140000, nachträglich als GwG-Beleg eingestufte
-- Dokumente, beim Upload nicht lesbare Dateien) zählt jetzt der Worker-Job
-- pdf-page-count-backfill nach: aus genau den gespeicherten Bytes (Länge und
-- SHA-256 geprüft) im begrenzten Worker-Thread, mit demselben Programm und
-- denselben Grenzen wie beim Upload.
--
-- pdf_page_count_checked_at hält fest, dass der Nachtrag eine Version
-- abschließend geprüft hat: gezählt (pdf_page_count gesetzt) oder nicht lesbar
-- (pdf_page_count bleibt NULL). Ohne diese Marke würde jede nicht lesbare PDF
-- in jedem Lauf erneut geladen und geparst. NULL bedeutet: vom Nachtrag noch
-- nicht abschließend geprüft (Uploads setzen die Marke nicht).
--
-- Wie pdf_page_count eine aus dem Inhalt abgeleitete Metadatenangabe, kein
-- Inhaltsfeld: Trigger und Unveränderlichkeitsschutz von document_version
-- bleiben unverändert (DOC-VERSION-IMMUTABILITY-001 unberührt). Versionen
-- zugeordneter GwG-Belege (gwg_id_document) und Dokumente in Vernichtung sperrt
-- block_version_during_gwg_destruction weiterhin gegen jede Änderung; der
-- Nachtrag lässt sie aus, ihre Seitenzahl zählt die Ausschnittsprüfung wie
-- bisher vor ihrer Transaktion.
--
-- Aufwand beim Deploy: Die Spalte ohne Default ist eine reine
-- Katalogänderung.
BEGIN;

ALTER TABLE public.document_version
  ADD COLUMN pdf_page_count_checked_at TIMESTAMPTZ(6);

COMMENT ON COLUMN public.document_version.pdf_page_count_checked_at IS
  'P-13: Zeitpunkt, zu dem der Nachtrag pdf-page-count-backfill die Version abschließend geprüft hat (gezählt oder nicht lesbar); NULL = nicht geprüft.';

COMMIT;
