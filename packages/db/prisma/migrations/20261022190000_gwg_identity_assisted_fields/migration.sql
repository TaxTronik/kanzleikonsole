-- GWG-OCR-ASSIST-001 / GWG-SELF-ONBOARDING-001
--
-- Herkunft der Angaben aus der Online-Einreichung: welche Felder der Mandant aus
-- der lokalen Ausweishilfe übernommen und damit ausdrücklich angehakt hat. Es
-- werden nur Feldnamen gespeichert, keine Werte (keine zweite Kopie der
-- Personendaten). Die Angabe beschreibt den Stand der Einreichung, ist kein
-- Prüfnachweis und verschwindet mit der Personenzeile (Vernichtung der Prüfung).
-- Additiv mit Default: bestehende Zeilen und das Vorgänger-Release bleiben
-- unberührt (Expand/Contract).
ALTER TABLE public.gwg_beneficial_owner
  ADD COLUMN identity_assisted_fields TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE public.gwg_representative
  ADD COLUMN identity_assisted_fields TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN public.gwg_beneficial_owner.identity_assisted_fields IS
  'Feldnamen, die bei der Online-Einreichung aus der lokalen Ausweishilfe übernommen wurden (GWG-OCR-ASSIST-001); kein Prüfnachweis.';
COMMENT ON COLUMN public.gwg_representative.identity_assisted_fields IS
  'Feldnamen, die bei der Online-Einreichung aus der lokalen Ausweishilfe übernommen wurden (GWG-OCR-ASSIST-001); kein Prüfnachweis.';
