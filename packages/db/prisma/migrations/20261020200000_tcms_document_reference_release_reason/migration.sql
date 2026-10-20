-- TCMS-NACHWEIS-001.
--
-- CHECK-Lücke aus kk-tcms-qual (offener Punkt 1): tcms_document_reference_
-- release_check nahm eine Freigabe ohne Grund an. Mit released_at und
-- released_by gesetzt und release_reason NULL ergab der zweite Zweig
-- `TRUE AND TRUE AND (NULL = ANY (…))` = NULL, der erste FALSE; FALSE OR NULL
-- ist NULL, und ein CHECK gilt bei NULL als erfüllt (dreiwertige Logik).
--
-- Änderung: Der zweite Zweig verlangt zusätzlich `release_reason IS NOT
-- NULL`; die Konjunktion wird damit FALSE statt NULL, und die Bedingung ist
-- für jede Zeile TRUE oder FALSE. Eine Freigabe ohne Grund weist die
-- Datenbank für jede Rolle ab (SQLSTATE 23514). Die erlaubten Gründe
-- (REMOVED, NOT_ATTACHED, DISCARDED) und alle übrigen Regeln bleiben
-- unverändert; geprüft sind alle CHECKs der TCMS-Tabellen auf dieselbe Falle
-- (nur diese Bedingung war betroffen, packages/db tcms-db-regeln.test.ts).
--
-- Bestand: Die kanzleikonsole schreibt eine Freigabe nur mit Grund. Eine
-- Zeile ohne Grund kann nur durch direktes Schreiben entstanden sein; dann
-- bricht die Migration mit einer eindeutigen Meldung ab, statt still einen
-- Grund zu erfinden (Klärung durch den Betrieb, Anzahl in der Meldung).
-- Daten, Trigger, RLS und Rechte bleiben unverändert.
BEGIN;

DO $$
DECLARE
  anzahl BIGINT;
BEGIN
  SELECT count(*) INTO anzahl
    FROM public."tcms_document_reference"
   WHERE "released_at" IS NOT NULL
     AND "released_by" IS NOT NULL
     AND "release_reason" IS NULL;
  IF anzahl > 0 THEN
    RAISE EXCEPTION 'tcms_document_reference: % Freigabe(n) ohne Grund; vor der Migration klären (TCMS-NACHWEIS-001)', anzahl
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

ALTER TABLE public."tcms_document_reference"
  DROP CONSTRAINT "tcms_document_reference_release_check",
  ADD CONSTRAINT "tcms_document_reference_release_check" CHECK (
    ("released_at" IS NULL AND "released_by" IS NULL AND "release_reason" IS NULL)
    OR ("released_at" IS NOT NULL AND "released_by" IS NOT NULL
        AND "release_reason" IS NOT NULL
        AND "release_reason" IN ('REMOVED', 'NOT_ATTACHED', 'DISCARDED'))
  );

COMMIT;
