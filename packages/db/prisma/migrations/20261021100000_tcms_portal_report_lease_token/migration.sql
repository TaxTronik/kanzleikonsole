-- TCMS-NACHWEIS-001.
--
-- kk-tcms-fix4, Befund RT3C-K-01 und zweites Fenster derselben Klasse: Die
-- Lease eines Meldevorgangs (tcms_portal_report) regelte nur, WANN ein
-- anderer Versuch übernehmen darf (lease_until abgelaufen), nicht, WER sie
-- gerade hält. Ein Absender mit abgelaufener Lease konnte nach fremder
-- Beanspruchung durch die Klärung noch als gesendet markieren und senden,
-- während die Klärung den Vorgang als „nie gesendet“ auflöste und seine
-- Anlagen freigab – obwohl das Ereignis im Tax-CMS existieren kann.
--
-- Änderung: lease_token hält den Besitz der Lease. Jede Beanspruchung setzt
-- lease_until und ein neues Token; Markieren als gesendet und jede Klärung
-- außer der Annahme verlangen das eigene Token in der Bedingung ihres
-- Statements (apps/web/src/server/tcms/portal/meldevorgang.ts). Eine Lease
-- ohne Besitzer (oder umgekehrt) gibt es nicht (CHECK, NULL-sicher über den
-- Vergleich von IS NULL).
--
-- Bestand: Laufende Leases erhalten ein Token, das niemand hält; sie laufen
-- ab und werden danach neu beansprucht. Daten, Trigger, RLS und Rechte
-- bleiben unverändert.
BEGIN;

ALTER TABLE public."tcms_portal_report" ADD COLUMN "lease_token" UUID;

UPDATE public."tcms_portal_report"
   SET "lease_token" = gen_random_uuid()
 WHERE "lease_until" IS NOT NULL;

ALTER TABLE public."tcms_portal_report"
  ADD CONSTRAINT "tcms_portal_report_lease_check"
    CHECK (("lease_token" IS NULL) = ("lease_until" IS NULL));

COMMIT;
