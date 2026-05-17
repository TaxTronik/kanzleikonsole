-- =============================================================================
-- Iter 47 — TOTP-Setup-Fenster mit TTL (M-3)
--
-- Bisher: solange totpEnrolledAt = null und totpSecretEnc != null, kann
-- jeder mit gültigem Passwort den QR-Code beliebig oft abrufen. Wenn der
-- Initial-Admin sein Setup nicht sofort abschließt, kann ein Angreifer mit
-- dem Initialpasswort später den Account übernehmen.
--
-- Fix: Zeitstempel `totp_setup_started_at` beim ersten Secret-Set. Wenn
-- älter als 60 Minuten und noch nicht enrollt, wird der Setup-Versuch
-- abgelehnt (Secret bleibt in DB für Audit, aber kann nicht mehr für
-- Enrollment genutzt werden). Admin muss dann den Account neu provisionieren
-- (z. B. Passwort-Reset über Out-of-Band).
-- =============================================================================

ALTER TABLE "staff_user"
  ADD COLUMN "totp_setup_started_at" TIMESTAMP(3);
