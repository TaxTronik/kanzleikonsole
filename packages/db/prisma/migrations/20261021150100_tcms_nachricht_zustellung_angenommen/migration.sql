-- Fachkatalog: MAIL-OUTBOX-001
--
-- kk-tcms-s11, Produktentscheidung (Rey Koxha, 21.10.2026; fachlich
-- ungeprüft): „Zugestellt“ heißt zugestellt. Der Zustell-Worker meldet eine
-- Mitteilung an einen Kontakt dem Tax-CMS erst als zugestellt, wenn ihr
-- Versandauftrag PROVIDER_ACCEPTED erreicht (der Mailserver des Anbieters hat
-- angenommen – mehr ist ohne Zustellbericht nicht feststellbar); bei jedem
-- anderen Endstatus (FAILED, NO_RECIPIENT, PARTIAL_FAILURE, UNKNOWN, SKIPPED,
-- auch nach Ablauf des Fensters) oder fehlendem Auftrag als unzustellbar.
--
-- Zustandsmaschine von tcms_nachricht_zustellung:
--   EINGEPLANT   Versandauftrag angelegt, Versand läuft (offen, kein Grund,
--                nur Mitteilungen an Kontakte)
--   ANGENOMMEN   Mail vom Mailserver angenommen bzw. In-App-Hinweis an eine
--                Kanzleiperson angelegt (abgeschlossen, kein Grund)
--   GESCHEITERT  Versandauftrag ohne Annahme beendet (abgeschlossen, fester
--                Grund; VERSAND_* nur hier; nur Mitteilungen an Kontakte)
--   ZURUECKGESTELLT / UNZUSTELLBAR  unverändert (Empfängerprüfung vor der
--                Einplanung)
--   gemeldet_am  Meldung an das Tax-CMS angekommen (oder 404/409), nur für
--                Abgeschlossenes.
--
-- Altbestand: EINGEPLANT hieß bisher „eingeplant und abgeschlossen“. Hinweise
-- an Kanzleipersonen und bereits als zugestellt gemeldete Zeilen werden
-- ANGENOMMEN (dem Tax-CMS ist „zugestellt“ schon gemeldet); noch nicht
-- gemeldete Mails bleiben EINGEPLANT und übernehmen beim nächsten Lauf den
-- Endstatus ihres Auftrags.
BEGIN;

ALTER TABLE public."tcms_nachricht_zustellung"
  DROP CONSTRAINT "tcms_nachricht_zustellung_status_check",
  DROP CONSTRAINT "tcms_nachricht_zustellung_grund_check",
  DROP CONSTRAINT "tcms_nachricht_zustellung_abschluss_check";

UPDATE public."tcms_nachricht_zustellung"
   SET "status" = 'ANGENOMMEN'
 WHERE "status" = 'EINGEPLANT'
   AND ("zweck" = 'EREIGNIS_GEMELDET' OR "gemeldet_am" IS NOT NULL);
UPDATE public."tcms_nachricht_zustellung"
   SET "abgeschlossen_am" = NULL
 WHERE "status" = 'EINGEPLANT';

ALTER TABLE public."tcms_nachricht_zustellung"
  ADD CONSTRAINT "tcms_nachricht_zustellung_status_check" CHECK ("status" IN (
    'EINGEPLANT', 'ANGENOMMEN', 'GESCHEITERT', 'ZURUECKGESTELLT', 'UNZUSTELLBAR'
  )),
  -- Feste Codes ohne personenbezogene Angaben; ohne Grund nur eingeplant bzw.
  -- angenommen; die Versandgründe nur für GESCHEITERT.
  ADD CONSTRAINT "tcms_nachricht_zustellung_grund_check" CHECK (
    ("status" IN ('EINGEPLANT', 'ANGENOMMEN')) = ("grund" IS NULL)
    AND ("grund" IS NULL OR "grund" IN (
      'ABGELAUFEN',
      'MANDANT_UNBEKANNT', 'MANDANT_INAKTIV',
      'KONTAKT_UNBEKANNT', 'KONTAKT_ANDERER_MANDANT', 'KONTAKT_INAKTIV',
      'KONTAKT_OHNE_EMAIL', 'KONTAKT_UNBESTAETIGT',
      'PERSON_UNBEKANNT', 'PERSON_INAKTIV', 'PERSON_OHNE_ZUGRIFF',
      'VERSAND_GESCHEITERT', 'VERSAND_UNKLAR', 'VERSAND_VERWORFEN', 'AUFTRAG_FEHLT'
    ))
    AND ("status" = 'GESCHEITERT' OR "grund" IS NULL OR "grund" NOT IN (
      'VERSAND_GESCHEITERT', 'VERSAND_UNKLAR', 'VERSAND_VERWORFEN', 'AUFTRAG_FEHLT'
    ))
  ),
  -- Offen sind ZURUECKGESTELLT und EINGEPLANT; gemeldet wird nur Abgeschlossenes.
  ADD CONSTRAINT "tcms_nachricht_zustellung_abschluss_check" CHECK (
    ("status" IN ('ZURUECKGESTELLT', 'EINGEPLANT')) = ("abgeschlossen_am" IS NULL)
    AND ("gemeldet_am" IS NULL OR "abgeschlossen_am" IS NOT NULL)
  ),
  -- Über die Mail-Outbox (EINGEPLANT, GESCHEITERT) gehen nur Mitteilungen an
  -- Kontakte; ein Hinweis an eine Kanzleiperson ist mit der Einplanung angenommen.
  ADD CONSTRAINT "tcms_nachricht_zustellung_mail_check" CHECK (
    "status" NOT IN ('EINGEPLANT', 'GESCHEITERT') OR "zweck" <> 'EREIGNIS_GEMELDET'
  );

COMMIT;
