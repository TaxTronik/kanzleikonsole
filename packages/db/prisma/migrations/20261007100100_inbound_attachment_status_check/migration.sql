-- MAIL-INBOX-001 (inbound_attachment.status).
--
-- Folge zu Review-Finding D-07 (20261005100600_status_text_checks): Auch der
-- Anhangstatus der Smart-Mailbox war freier Text ohne jede Prüfung. Er bekommt
-- wie inbound_message.status einen Text-CHECK mit genau den Werten, die der
-- Code schreibt:
--  * packages/mail/src/imap.ts (IMAP-Abruf im Systemkontext): PENDING (Default
--    beim Anlegen und vor dem Staging), SCAN_ERROR (Virenscanner nicht
--    verfügbar), BLOCKED (gesperrter Typ, Größe oder Schadsoftware), CLEAN
--    (Scannerfreigabe).
--  * apps/web/src/app/staff/(protected)/mailbox/actions.ts (Archivübernahme):
--    IMPORTING (Claim), IMPORTED (abgeschlossen). app.guard_inbound_attachment
--    lässt Staff ohnehin nur diese beiden Zielwerte zu.
-- Ein neuer Statuswert braucht künftig eine Migration, die den CHECK erweitert.
--
-- Bestand: Wie 20261005100600 bricht die Vorprüfung mit jedem abweichenden Wert
-- und seiner Anzahl ab, statt ihn still umzuschreiben; ein solcher Wert stammt
-- nicht aus dem Code und ist vor dem Deploy zu klären. row_security = off lässt
-- die Prüfung scheitern, statt Zeilen zu übersehen, falls die Rolle RLS nicht
-- umgeht. Der CHECK wird sofort validiert (kein NOT VALID).
--
-- risk_marking.engine_status bleibt ohne CHECK: Der Wert stammt unverändert aus
-- der externen Analyse-Engine (packages/risk-layer, z.string()), ein neuer
-- Engine-Status ist dort ausdrücklich zulässig.
--
-- Aufwand beim Deploy: ein Lauf über die Tabelle unter Tabellensperre; eine
-- Zeile je E-Mail-Anhang.
BEGIN;

SET LOCAL row_security = off;

DO $$
DECLARE
  unexpected TEXT;
BEGIN
  SELECT string_agg(format('inbound_attachment.status = %L (%s Zeilen)', status, n), ', '
                    ORDER BY status)
    INTO unexpected
    FROM (
      SELECT status, count(*) AS n
        FROM public.inbound_attachment
       WHERE status NOT IN ('PENDING', 'SCAN_ERROR', 'BLOCKED', 'CLEAN', 'IMPORTING', 'IMPORTED')
       GROUP BY status
    ) AS bad;
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'D-07: Statuswerte außerhalb der zulässigen Liste: %', unexpected
      USING HINT = 'Werte fachlich klären und bereinigen, dann die Migration erneut ausführen.';
  END IF;
END
$$;

ALTER TABLE public.inbound_attachment
  ADD CONSTRAINT inbound_attachment_status_check
  CHECK (status IN ('PENDING', 'SCAN_ERROR', 'BLOCKED', 'CLEAN', 'IMPORTING', 'IMPORTED'));

COMMIT;
