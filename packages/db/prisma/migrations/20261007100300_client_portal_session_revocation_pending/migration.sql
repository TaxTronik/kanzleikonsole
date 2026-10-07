-- GWG-REVERIFICATION-VALIDITY-001 (Deaktivierung bei Ablauf durch
-- gwg-expiry-check) / ACCESS-TENANT-RLS-001 (Portal-Session-Widerruf).
--
-- Review-Finding B7: Der Worker gwg-expiry-check deaktiviert bei Ablauf eines
-- GwG-Checks den Mandanten in einer Transaktion und widerruft erst nach dem
-- Commit die Portal-Sessions der Kontakte in Redis (revoke:portal:<contactId>).
-- Scheiterte der Widerruf oder brach der Prozess dazwischen ab, blieb die
-- Deaktivierung bestehen, aber kein Lauf widerrief erneut: Der Check ist dann
-- EXPIRED und kein Kandidat mehr. Eine spätere Reaktivierung hätte vorher
-- ausgestellte, noch nicht abgelaufene Sessions wieder gültig gemacht.
--
-- client.portal_session_revocation_pending_at hält die Deaktivierung fest, deren
-- Widerruf noch nicht bestätigt ist. Der Worker setzt die Spalte in derselben
-- Transaktion wie die Deaktivierung, löscht sie erst nach bestätigtem Widerruf
-- aller aktiven Kontakte per Compare-and-Set auf den gelesenen Wert und arbeitet
-- offene Marker zu Beginn jedes Laufs ab, auch in den BullMQ-Wiederholungen
-- (packages/db/src/portal-session-revocation.ts). TIMESTAMPTZ(3) entspricht der
-- Millisekundenauflösung von JavaScript; der Vergleich ist damit exakt und
-- unabhängig von der Sitzungszeitzone.
--
-- Der Teilindex enthält nur offene Marker (im Normalfall keinen) und hält die
-- Abfrage zu Beginn jedes Laufs unabhängig von der Mandantenzahl. Er steht nur
-- in dieser Migration, nicht in schema.prisma.
--
-- Expand-Schritt: neue, nullable Spalte ohne Default, bestehende Zeilen bleiben
-- NULL (kein offener Widerruf). Noch laufende alte App- und Worker-Prozesse
-- kennen die Spalte nicht und lesen oder schreiben sie nicht. Aufwand beim
-- Deploy: kurze Tabellensperre für ADD COLUMN (kein Rewrite) und ein Lauf über
-- client für den Index.
BEGIN;

ALTER TABLE public."client"
  ADD COLUMN "portal_session_revocation_pending_at" TIMESTAMPTZ(3);

COMMENT ON COLUMN public."client"."portal_session_revocation_pending_at" IS
  'B7: Deaktivierung, deren Portal-Session-Widerruf noch nicht bestätigt ist (gwg-expiry-check); NULL = kein offener Widerruf.';

CREATE INDEX "client_portal_session_revocation_pending_idx"
  ON public."client" ("portal_session_revocation_pending_at")
  WHERE "portal_session_revocation_pending_at" IS NOT NULL;

COMMIT;
