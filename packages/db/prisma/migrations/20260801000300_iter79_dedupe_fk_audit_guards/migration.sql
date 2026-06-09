-- =============================================================================
-- iter79 — RF-9 + RF-15: Dedupe-Index-Lücken schließen + Aufbewahrungs-Schutz.
--
-- Teil 1 (RF-9): notification_daily_dedupe (iter49/52) hatte zwei Lücken:
--   a) POA_EXPIRY_SOON/POA_EXPIRED fehlten in der Kind-Liste — iter59 hat nur
--      die Enum-Werte ergänzt, nicht den Index. Der P2002-Pfad in
--      apps/worker/src/notify.ts griff für poa-expiry-check damit nie.
--   b) staff_id IS NOT NULL schloss globale Notifications (staff_id = NULL,
--      z. B. TAX_NOTICE_APPEAL_REMINDER ohne Prüfer aus reminders-daily) aus
--      dem Index aus — ein Doppellauf duplizierte sie.
--   Fix: Kind-Liste erweitern + zweiter Partial-Unique-Index für den
--   NULL-staff-Fall (NULL-Werte sind in Unique-Indizes nie gleich, daher
--   braucht es den separaten Index ohne staff_id im Schlüssel). Gleiche
--   IMMUTABLE-Tag-Bucket-Technik wie iter49: floor(extract(epoch …)/86400).
--
-- Teil 2 (RF-15): gwg_check und power_of_attorney hingen mit ON DELETE CASCADE
--   am Mandanten — ein Client-Hard-Delete hätte GwG-Akten (5-Jahres-Pflicht,
--   § 8 GwG) und signierte Vollmachten mitgelöscht. Umstellung auf NO ACTION
--   (statt RESTRICT): blockiert den direkten Client-Delete genauso, erlaubt
--   aber weiterhin die Tenant-Kaskade (tenant → client + tenant → gwg_check/
--   power_of_attorney im selben Statement; NO ACTION prüft am Statement-Ende,
--   RESTRICT bräche die Tenant-Löschung sofort ab). In der App ist aktuell
--   kein Client-Hard-Delete exponiert — das ist reine Defense in Depth.
-- =============================================================================

-- ----- Teil 1: Dedupe-Indizes (RF-9) ----------------------------------------

DROP INDEX IF EXISTS notification_daily_dedupe;

CREATE UNIQUE INDEX notification_daily_dedupe
  ON notification (
    tenant_id,
    staff_id,
    kind,
    resource_id,
    (floor(extract(epoch from created_at) / 86400))
  )
  WHERE kind IN (
    'TAX_NOTICE_APPEAL_REMINDER',
    'CLIENT_REMINDER_DUE',
    'PENDING_BINDER_OVERDUE',
    'INVOICE_OVERDUE',
    'GWG_EXPIRY_90D',
    'GWG_EXPIRY_30D',
    'GWG_EXPIRED',
    'GWG_ID_EXPIRY_SOON',
    'GWG_ID_EXPIRED',
    'POA_EXPIRY_SOON',
    'POA_EXPIRED'
  )
    AND resource_id IS NOT NULL
    AND staff_id IS NOT NULL;

-- Globale (staff_id = NULL) System-Notifications: eigener Index, weil NULL im
-- Index oben jede Zeile unique macht und der Dedupe damit nie greift.
CREATE UNIQUE INDEX notification_daily_dedupe_nullstaff
  ON notification (
    tenant_id,
    kind,
    resource_id,
    (floor(extract(epoch from created_at) / 86400))
  )
  WHERE kind IN (
    'TAX_NOTICE_APPEAL_REMINDER',
    'CLIENT_REMINDER_DUE',
    'PENDING_BINDER_OVERDUE',
    'INVOICE_OVERDUE',
    'GWG_EXPIRY_90D',
    'GWG_EXPIRY_30D',
    'GWG_EXPIRED',
    'GWG_ID_EXPIRY_SOON',
    'GWG_ID_EXPIRED',
    'POA_EXPIRY_SOON',
    'POA_EXPIRED'
  )
    AND resource_id IS NOT NULL
    AND staff_id IS NULL;

-- ----- Teil 2: FK-Schutz Aufbewahrungspflichten (RF-15) ----------------------

ALTER TABLE "gwg_check" DROP CONSTRAINT "gwg_check_client_id_fkey";
ALTER TABLE "gwg_check" ADD CONSTRAINT "gwg_check_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "power_of_attorney" DROP CONSTRAINT "power_of_attorney_client_id_fkey";
ALTER TABLE "power_of_attorney" ADD CONSTRAINT "power_of_attorney_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
