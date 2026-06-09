-- =============================================================================
-- iter77 — RF-6: Audit-Zeitstempel auf timestamptz umstellen.
--
-- occurred_at fließt via Date#toISOString() in den Ketten-Hash (chain.ts).
-- Als TIMESTAMP WITHOUT TIME ZONE interpretiert node-pg den Spaltenwert beim
-- Lesen in der PROZESS-Zeitzone: eine Verify-CLI, die in einer anderen TZ als
-- der Writer läuft (z. B. Prüfer-Laptop Europe/Berlin vs. UTC-Container),
-- rekonstruiert dann andere ISO-Strings → falscher „Kettenbruch"-Befund.
-- timestamptz speichert den absoluten Zeitpunkt; node-pg liefert dieselbe
-- UTC-Instant unabhängig von der Session-/Prozess-TZ.
--
-- USING … AT TIME ZONE 'UTC': Annahme, dass alle bisherigen Writer in UTC
-- liefen (Web/Worker laufen in Docker-Containern ohne TZ-Override, Node-Default
-- UTC) — die gespeicherten Klartext-Werte SIND also UTC und werden 1:1 als
-- solche reinterpretiert. Damit bleiben die bestehenden Hashes gültig.
--
-- WICHTIG für Folge-Code: `occurred_at::date`-Vergleiche hängen nach dieser
-- Umstellung von der DB-Session-TZ ab und sind nicht index-fähig — sealDay
-- (packages/evidence/src/service.ts) nutzt deshalb jetzt eine explizite
-- UTC-Halboffen-Range (>= dayStartUtc AND < nextDayStartUtc).
-- =============================================================================

ALTER TABLE "audit_log"
  ALTER COLUMN "occurred_at" TYPE timestamptz(6) USING "occurred_at" AT TIME ZONE 'UTC';

ALTER TABLE "audit_seal"
  ALTER COLUMN "sealed_at" TYPE timestamptz(6) USING "sealed_at" AT TIME ZONE 'UTC';

ALTER TABLE "audit_archive"
  ALTER COLUMN "from_occurred_at" TYPE timestamptz(6) USING "from_occurred_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "to_occurred_at" TYPE timestamptz(6) USING "to_occurred_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "archived_at" TYPE timestamptz(6) USING "archived_at" AT TIME ZONE 'UTC';

-- RF-16: record() macht pro Insert einen Vorgänger-Lookup
-- `WHERE tenant_id = … ORDER BY id DESC LIMIT 1` — ohne diesen Index ein
-- wachsender Scan über (tenant_id, occurred_at)-Indexpfade.
CREATE INDEX "audit_log_tenant_id_id_idx" ON "audit_log"("tenant_id", "id");
