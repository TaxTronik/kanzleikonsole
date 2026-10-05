-- GWG-IDENTIFICATION-EVIDENCE-001 / GWG-SELF-ONBOARDING-001 (Ausweisausschnitte
-- gegen die gebundene Originalversion prüfen).
--
-- Review-Finding P-13. Die Prüfung eines Ausweisausschnitts lud bei PDFs die
-- Originaldatei (bis 25 MiB) aus dem Objektspeicher, hashte und parste sie im
-- Hauptthread, während Lifecycle-Lock und Zeilensperren gehalten wurden. Die
-- Seitenzahl wird jetzt beim Upload einer PDF-Ausweisquelle einmalig aus genau
-- diesen Bytes ermittelt (begrenzter Worker-Thread) und an der Version
-- gespeichert. In der Transaktion vergleicht die Prüfung nur noch Version-ID
-- und SHA-256; Altbestand ohne gespeicherte Seitenzahl wird vor der
-- Transaktion gezählt.
--
-- NULL bedeutet: kein PDF, beim Upload nicht lesbar oder vor dieser Migration
-- hochgeladen. Es gibt deshalb keinen Backfill; die Annahmeentscheidung
-- bleibt für diese Versionen dieselbe, nur die Zählung läuft vor der
-- Transaktion. Der Wert ist aus dem Inhalt abgeleitete Metadatenangabe, kein
-- Inhaltsfeld: Trigger und Unveränderlichkeitsschutz von document_version
-- bleiben unverändert (DOC-VERSION-IMMUTABILITY-001 unberührt).
--
-- Aufwand beim Deploy: Die Spalte ohne Default ist eine reine
-- Katalogänderung; der CHECK prüft den Bestand in einem Lauf über
-- document_version (alle Werte NULL).
BEGIN;

ALTER TABLE public.document_version
  ADD COLUMN pdf_page_count INTEGER,
  ADD CONSTRAINT document_version_pdf_page_count_check
    CHECK (pdf_page_count IS NULL OR pdf_page_count >= 0);

COMMENT ON COLUMN public.document_version.pdf_page_count IS
  'P-13: Seitenzahl einer PDF-Ausweisquelle, beim Upload aus genau diesen Bytes ermittelt; NULL = kein PDF, nicht lesbar oder Altbestand.';

COMMIT;
