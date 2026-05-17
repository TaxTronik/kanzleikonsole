-- =============================================================================
-- Iter 44 — POA-OTP Brute-Force-Schutz (N1)
--
-- Hintergrund (Re-Review N1): Die 6-stellige OTP-Bestätigung für die
-- eIDAS-konforme Vollmacht-Signatur (fortgeschrittene elektronische
-- Signatur) hatte keinen Versuchszähler. Mit Signing-Token (72h gültig) +
-- 10 req/sec wäre die OTP im Mittel in ~14h knackbar.
--
-- Fix: Zähler `signing_otp_attempts` pro POA. Bei N=5 Fehlversuchen werden
-- Token + OTP-Hash entwertet — die Signatur muss neu angefordert werden.
-- =============================================================================

ALTER TABLE "power_of_attorney"
  ADD COLUMN "signing_otp_attempts" INTEGER NOT NULL DEFAULT 0;
