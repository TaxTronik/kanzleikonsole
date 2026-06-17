# Technische Modulbeschreibung: Backup und Restore

## Zweck

Tägliche Datenbanksicherung in den internen Object-Store mit kryptografischer
Integritätssicherung — plus **beweisbarer** Wiederherstellbarkeit: jeder
Software-Stand wird im CI per Restore-Roundtrip geprüft, jede Installation
monatlich per Restore-Drill (Art. 32 Abs. 1 lit. d DSGVO).

## Komponenten

- **Runner** (`apps/web/src/server/backup/runner.ts`): `pg_dump`
  (custom-Format, komprimiert; Passwort via PGPASSWORD, nie in Prozess-Args)
  → lokale Operator-Kopie unter `BACKUP_LOCAL_DIR` (Default `backups/`) →
  Streaming-Upload in den `backups`-Bucket; SHA-256/Größe stammen aus
  demselben Dump. `BackupRecord` je Tenant (RUNNING→SUCCESS/FAILED, Hash, Key)
  + Audit `backup.run` in derselben Tx.
  Datei-Modus (`--out-file`) für Selbsttest/Air-Gap mit identischen Flags.
- **Restore-CLI** (`./taxtronik restore`, intern `restore.ts`):
  `--list/--latest/--key/--file`;
  S3-Restores verifizieren den SHA-256 **gegen den BackupRecord** (Abbruch
  bei Abweichung); Ziel-DB-Leer-Check mit explizitem `--confirm-overwrite`;
  `pg_restore --single-transaction --exit-on-error` (ganz oder gar nicht);
  Smoke-Test (Tenants/Audit-Zählung) nach Restore.
- **Restore-Drill** (Worker, monatlich 1., 05:00 UTC): letztes
  SUCCESS-Backup → Wegwerf-DB (S3→pg_restore-stdin-Stream, SHA-Check) →
  `verifyChain` je Tenant auf der **wiederhergestellten** DB; Ergebnis als
  `tenant_setting` (Admin-Karte) + Audit `backup.drill.*` in der
  Produktiv-Chain; Fehlschlag → Admin-Notification.
- **CI-Selbsttest** (`scripts/restore-selftest.sh`, Job `restore`): echter
  runner→restore-Roundtrip je Commit mit Zeilenzahl-Assertions + Chain-
  Verifikation; Protokoll als CI-Artefakt.
- **Operator/Admin:** `./taxtronik backup` (Cron-Pflicht des Betreibers — kein
  App-interner Tagesjob, bewusst), Admin-Übersicht mit Browser-Trigger und
  getrenntem Download lokaler Kopie oder S3-Objekt; `./taxtronik restore`
  spielt S3- oder lokale Dump-Quellen zurück; Deploy/Update sichern automatisch
  vor jeder Migration; DR-Runbook mit Rollback-Pfaden.

## Traceability

| Anforderung | Implementierung | Test/Nachweis |
|---|---|---|
| Backup integritätsgesichert | SHA-256 in BackupRecord, Verify beim Restore | restore.ts-Hash-Abbruchpfad; CI-Roundtrip |
| Wiederherstellbarkeit je Software-Stand | restore-selftest.sh | CI-Job `restore` (Artefakt `testbericht-restore`) |
| Wiederherstellbarkeit je Installation | backup-drill-Worker | `backup-drill.test.ts` (Helfer) + End-to-End über echte Queue/Image (verifiziert 2026-06-10); Audit-Events in der Chain |
| Ganz-oder-gar-nicht-Restore | --single-transaction | CI-Roundtrip |
| Migration nie ohne Backup | ops-lib `backup_before_migrations` | ./taxtronik deploy/update |
| Sichtbarkeit | Admin-Backup-Karte + Drill-Ergebnis + Browser-Trigger/Download | manuelle Abnahme |

## Bekannte Grenzen

Object-Store-Inhalte (Dokumente) sichert das DB-Backup nicht — externe
Replikation/Backup des SeaweedFS-Volumes ist Betreiber-Pflicht (DR-Runbook
Abschnitt 4); keine Unit-Tests direkt für runner/restore (Abdeckung über den
CI-Roundtrip, der exakt den Produktionscode-Pfad fährt).
