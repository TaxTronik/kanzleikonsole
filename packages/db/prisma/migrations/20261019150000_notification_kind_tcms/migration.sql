-- Fachkatalog: MAIL-OUTBOX-001
-- (notification_kind aus 20260521000000_iter8_notifications, zuletzt als Typ neu
-- angelegt in 20260801000600_iter81)
--
-- TCMS Stufe 4: Der Worker tcms-nachrichten-zustellen stellt den Postausgang
-- des Tax-CMS zu. Zwei neue In-App-Hinweise:
--   - TCMS_EREIGNIS_GEMELDET: Ein Mandantenkontakt hat im Portal ein Ereignis
--     gemeldet; Empfänger ist die vom Tax-CMS genannte, von der kanzleikonsole
--     geprüfte Kanzleiperson (Titel und Nummer, kein weiterer Inhalt).
--   - TCMS_ZUSTELLUNG_GESCHEITERT: Eine Mitteilung des Tax-CMS ließ sich nicht
--     zustellen (Empfänger nicht bestätigt); einmal je Mitteilung an die
--     aktiven ADMIN/PARTNER, ohne Inhalt und ohne Code.
--
-- Die Enum-Werte stehen bewusst allein in dieser Migration: PostgreSQL darf sie
-- erst nach dem Commit verwenden.
BEGIN;

ALTER TYPE public.notification_kind
  ADD VALUE IF NOT EXISTS 'TCMS_EREIGNIS_GEMELDET';

ALTER TYPE public.notification_kind
  ADD VALUE IF NOT EXISTS 'TCMS_ZUSTELLUNG_GESCHEITERT';

COMMIT;
