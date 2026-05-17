-- =============================================================================
-- Iter 43 — Konto-Sperre nach N fehlgeschlagenen Login-Versuchen (S2)
--
-- Bisher hat `staff_user.locked_until` zwar im Login-Pfad gegriffen, aber
-- niemand hat den Wert je gesetzt — die Sperre war faktisch wirkungslos.
-- Mit `failed_login_count` zählen wir Fehlversuche pro Account und setzen
-- `locked_until` bei Erreichen des Schwellwerts (Logik in app/server-Code).
--
-- Default 0 für bestehende Reihen.
-- =============================================================================

ALTER TABLE "staff_user"
  ADD COLUMN "failed_login_count" INTEGER NOT NULL DEFAULT 0;
