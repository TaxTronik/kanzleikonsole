-- =============================================================================
-- iter84 — Portal-Audit 2026-06, Befunde 2 + 3 (docs/security/portal-audit-2026-06.md).
--
-- Teil 1: power_of_attorney.signing_otp_attempts_total — lebenszyklus-weiter
--   OTP-Fehlversuchszähler. Der bestehende Zähler signing_otp_attempts wird
--   beim OTP-Re-Issue bewusst auf 0 gesetzt (UX-Fix: neuer Code = frische
--   5 Versuche) — dadurch wuchs das Brute-Force-Fenster mit dem Issue-Cap 10
--   auf ~50 Gesamtversuche. Der neue Zähler überlebt Re-Issues und deckelt
--   bei 15; Reset nur beim Versand eines NEUEN Signatur-Tokens
--   (sendForSignatureAction = neuer Lebenszyklus).
--
-- Teil 2: client_contact.ical_token_version — geht in den HMAC des
--   iCal-Feed-Tokens ein (server/ical/feed.ts). Inkrementieren entwertet alle
--   ausgegebenen Feed-URLs NUR dieses Kontakts; vorher war Revocation nur
--   global über AUTH_SECRET-Rotation möglich. Bestehende Feed-URLs (altes
--   zweiteiliges Token-Format ohne Version) werden mit dem Deploy ungültig —
--   Mandanten sehen die neue Abo-URL im Portal (/portal/appointments).
-- =============================================================================

ALTER TABLE "power_of_attorney" ADD COLUMN "signing_otp_attempts_total" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "client_contact" ADD COLUMN "ical_token_version" INTEGER NOT NULL DEFAULT 1;
