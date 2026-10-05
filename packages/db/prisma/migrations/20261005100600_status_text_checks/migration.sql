-- MAIL-INBOX-001 (inbound_message.status) / BWA-PROJECTION-001 (bwa_plan.status;
-- der Planvergleich wertet FINAL-Pläne aus).
--
-- Review-Finding D-07. Beide Statusspalten waren freier Text ohne jede
-- Prüfung. Wie in den Modulen seit Ende August bekommen sie einen Text-CHECK
-- mit genau den Werten, die der Code schreibt; die Umstellung auf Enums ist
-- bewusst nicht Teil dieser Migration.
--  * inbound_message.status (packages/mail/src/imap.ts): PENDING (Default
--    beim Anlegen durch den IMAP-Abruf), BLOCKED (Größen- oder
--    Anhangslimit), COMPLETE (alle Anhänge verarbeitet).
--  * bwa_plan.status (CreateBwaPlanSchema/UpdateBwaPlanSchema in
--    apps/web/src/server/bwa/plans.ts): DRAFT (Default), FINAL.
-- Ein neuer Statuswert braucht künftig eine Migration, die den CHECK erweitert.
--
-- Bestand: Die Vorprüfung bricht mit jedem abweichenden Wert und seiner Anzahl
-- ab, statt ihn still umzuschreiben; ein solcher Wert stammt nicht aus dem
-- Code und ist vor dem Deploy zu klären. row_security = off lässt die Prüfung
-- scheitern, statt Zeilen zu übersehen, falls die Rolle RLS nicht umgeht.
--
-- Aufwand beim Deploy: je ein Lauf über beide Tabellen unter Tabellensperre
-- (Schreiber sind gestoppt); eine Zeile je eingegangener E-Mail bzw. je
-- Planversion, auch bei großen Kanzleien unter einer Sekunde.
BEGIN;

SET LOCAL row_security = off;

DO $$
DECLARE
  unexpected TEXT;
BEGIN
  SELECT string_agg(format('%s.status = %L (%s Zeilen)', tbl, status, n), ', ' ORDER BY tbl, status)
    INTO unexpected
    FROM (
      SELECT 'inbound_message' AS tbl, status, count(*) AS n
        FROM public.inbound_message
       WHERE status NOT IN ('PENDING', 'BLOCKED', 'COMPLETE')
       GROUP BY status
      UNION ALL
      SELECT 'bwa_plan', status, count(*)
        FROM public.bwa_plan
       WHERE status NOT IN ('DRAFT', 'FINAL')
       GROUP BY status
    ) AS bad;
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'D-07: Statuswerte außerhalb der zulässigen Liste: %', unexpected
      USING HINT = 'Werte fachlich klären und bereinigen, dann die Migration erneut ausführen.';
  END IF;
END
$$;

ALTER TABLE public.inbound_message
  ADD CONSTRAINT inbound_message_status_check
  CHECK (status IN ('PENDING', 'BLOCKED', 'COMPLETE'));

ALTER TABLE public.bwa_plan
  ADD CONSTRAINT bwa_plan_status_check
  CHECK (status IN ('DRAFT', 'FINAL'));

COMMIT;
