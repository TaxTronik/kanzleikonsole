# Technische Modulbeschreibung: Backup und Restore

## Zweck

Tägliche Datenbanksicherung in den internen Object-Store mit kryptografischer
Integritätssicherung — plus **beweisbarer** Wiederherstellbarkeit: jeder
Software-Stand wird im CI per Restore-Roundtrip geprüft, jede Installation
monatlich per Restore-Drill (Art. 32 Abs. 1 lit. d DSGVO).

## Komponenten

- **Manueller Runner** (`apps/web/src/server/backup/runner.ts`): `pg_dump`
  (custom-Format, komprimiert; Passwort via PGPASSWORD, nie in Prozess-Args)
  → lokale Operator-Kopie unter `BACKUP_LOCAL_DIR` (in Produktion Pflicht;
  Development-Default `backups/`) →
  Streaming-Upload in den `backups`-Bucket; SHA-256/Größe stammen aus
  demselben Dump. `BackupRecord` je Tenant (RUNNING→SUCCESS/FAILED, Hash, Key)
  - Audit `backup.run` in derselben Tx.
    Datei-Modus (`--out-file`) für Selbsttest/Air-Gap mit identischen Flags.
- **Tagesjob** (`apps/worker/src/jobs/backup-run.ts`, täglich 01:00 UTC):
  streamt denselben vollständigen Datenbank-Dump direkt nach S3 und erzeugt
  bewusst keine lokale Kopie im read-only Worker-Container. PostgreSQL-ACLs
  und sicherheitsrelevante REVOKEs sind Teil des Dumps; nur Ownership wird für
  die portable Wiederherstellung ausgelassen.
- **Kanzleidateien-Export** (`./taxtronik backup-files`): kopiert die
  SeaweedFS-Dokument-Buckets `gobd`, `gwg`, `general`, `staff-private` als
  lokale Byte-Kopie nach `backups/object-store/<timestamp>/`; allein keine
  Versions-/Object-Lock-Treue.
- **Full-Backup** (`./taxtronik backup-full`): globaler `flock`, konservativer
  Kapazitäts-Preflight und Signal-/EXIT-Cleanup; quiesziert App/Worker/n8n vor
  beiden DB-Dumps und dem Object-Export. Danach Cold-Snapshot der kompletten
  `seaweed_data`-, `redis_data`- und `n8n_data`-Volumes. DBs, Bytes, Volumes und
  `.env` werden gemeinsam per age verschlüsselt; nur das Ciphertext-Archiv und
  ein Ed25519-signiertes SHA-256-Inventar bleiben zurück.
- **Offsite-Vault**: optionaler Upload mit separaten Credentials; verlangt
  HTTPS, Versioning sowie Default Object Lock COMPLIANCE mit Mindestdauer und
  prüft für Ciphertext, Manifest und Signatur jeweils Größe, Retention und
  VersionId. `BACKUP_OFFSITE_REQUIRED=true` macht Offsite fail-closed.
- **Recovery-Werkzeuge**: `backup-verify` und `backup-decrypt` funktionieren
  auf einem frischen System ohne Produktiv-`.env`, wenn offline Public Key und
  age-Identity als Argument/Prozess-ENV übergeben werden.
- **Restore-CLI** (`./taxtronik restore`, intern `restore.ts`):
  strikter Parser für `--list/--latest/--key/--file`; mutierende Aufrufe
  verlangen genau ein explizites Ziel (`--target-url` oder stark bestätigtes
  `--production-target`); der Produktionspfad bindet das Backup über
  `--release-version X.Y.Z` an genau den anschließend erlaubten Release-Vertrag;
  S3-Restores verifizieren den SHA-256 **gegen den BackupRecord**, sofern die
  Referenz-DB noch verfügbar ist (Abbruch bei Abweichung, sonst Warnung);
  fail-closed Ziel-DB-Leer-Check über alle User-Relationen mit explizitem
  `--confirm-overwrite`; Produktionsrestore quiesziert App/Worker/n8n und lässt
  sie gestoppt;
  `pg_restore --single-transaction --exit-on-error` (ganz oder gar nicht);
  setzt die vorab aus der Betreiberkonfiguration angelegte Cluster-Rolle
  `taxtronik_app` voraus; Smoke-Test (Tenants/Audit-Zählung) nach Restore.
- **Restore-Drill** (Worker, monatlich 1., 05:00 UTC): letztes
  SUCCESS-Backup → Wegwerf-DB (S3→pg_restore-stdin-Stream, SHA-Check) →
  `verifyChain` je Tenant auf der **wiederhergestellten** DB; Ergebnis als
  `tenant_setting` (Admin-Karte) + Audit `backup.drill.*` in der
  Produktiv-Chain; Fehlschlag → Admin-Notification.
- **CI-Selbsttest** (`scripts/restore-selftest.sh`, Job `restore`): echter
  runner→restore-Roundtrip je Commit mit Zeilenzahl-, App-Rollen-/ACL-/REVOKE-
  Assertions + Chain-Verifikation; Protokoll als CI-Artefakt.
- **Operator/Admin:** automatischer Tagesjob im Worker; `./taxtronik backup`
  erzeugt bei Bedarf eine zusätzliche manuelle Sicherung samt lokaler
  Operator-Kopie. Start und Abruf vollständiger Dumps bleiben dem
  Betreiber-Host beziehungsweise S3-Zugriff vorbehalten. Die Admin-Oberfläche
  zeigt ausschließlich Status, Größe und Restore-Drill-Ergebnis.
  `./taxtronik restore`
  spielt S3- oder lokale Dump-Quellen zurück; Deploy/Update sichern automatisch
  vor jeder Migration; DR-Runbook mit Rollback-Pfaden.

## Traceability

| Anforderung                             | Implementierung                                                                      | Test/Nachweis                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Backup integritätsgeprüft               | SHA-256 in BackupRecord, Verify beim Restore, solange die Referenz-DB verfügbar ist  | restore.ts-Hash-Abbruchpfad; monatlicher Drill                                                                          |
| Wiederherstellbarkeit je Software-Stand | restore-selftest.sh                                                                  | CI-Job `restore` (Artefakt `testbericht-restore`)                                                                       |
| Wiederherstellbarkeit je Installation   | backup-drill-Worker                                                                  | `backup-drill.test.ts` (Helfer) + End-to-End über echte Queue/Image (verifiziert 2026-06-10); Audit-Events in der Chain |
| Ganz-oder-gar-nicht-Restore             | --single-transaction                                                                 | CI-Roundtrip                                                                                                            |
| Migration nie ohne Backup               | ops-lib `backup_before_migrations`                                                   | ./taxtronik deploy/update                                                                                               |
| Vollständiger Recovery Point sicherbar  | quiesziertes, age-verschlüsseltes `backup-full` + Cold-Volumes + signiertes Inventar | Manipulationstest; Betreiber-Vollsystem-Drill                                                                           |
| Sichtbarkeit ohne Dump-Zugriff          | Admin-Backup-Karte + Drill-Ergebnis; Trigger und Download nur durch Operator         | Route-Tests + manuelle Abnahme                                                                                          |

## Bekannte Grenzen

Object-Store-Inhalte (Dokumente) sichert das DB-only-Backup nicht;
`backup-files` bleibt eine versionstreue **ungeeignete** Notfall-Bytequelle.
Das Full-Backup enthält zwar den quieszierten kompletten SeaweedFS-Stand, aber
eine belastbare Wiederanlaufgarantie entsteht erst durch den vierteljährlichen
isolierten Betreiber-Drill (Volumes + beide DBs + App/n8n + fachliche
Stichproben). Die private Manifest-Signaturdatei sollte nur zum Backup gemountet
und der Public Key getrennt aufbewahrt werden; ein dauerhaft kompromittierter
Produktivhost kann sonst neue, formal gültige Fälschungen signieren. Der
automatische Worker-/CI-Drill deckt weiterhin nur Postgres/Audit-Chain ab.
