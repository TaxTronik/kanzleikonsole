-- Fachkatalog: ACCESS-TENANT-RLS-001 (mail_outbox aus 20261006120000_mail_outbox)
--
-- Folgebefund F-08: Vor jedem Versandversuch prüft der Worker, ob die Mail
-- noch gewollt ist (zurückgezogene oder abgelaufene GwG-Einladung, abgesagter
-- Termin, geschlossene Anforderung, ...). Eine nicht mehr gewollte Mail endet
-- im neuen Terminalstatus SKIPPED; Payload und geheime Variablen werden wie bei
-- jedem Terminalstatus entfernt, die Begründung steht in last_error.
--
-- Die bestehenden CHECKs passen ohne Änderung: SKIPPED trägt keinen nächsten
-- Versuch (mail_outbox_schedule_check) und keine geheimen Variablen
-- (mail_outbox_secret_check). Der Enum-Wert steht bewusst allein in dieser
-- Migration: PostgreSQL darf ihn erst nach dem Commit verwenden.
BEGIN;

ALTER TYPE public.mail_outbox_status
  ADD VALUE IF NOT EXISTS 'SKIPPED';

COMMIT;
