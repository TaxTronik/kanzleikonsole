# Disaster-Recovery-Runbook

Was tun, wenn die taxtronik-Installation einer Kanzlei beschädigt ist oder
ausfällt? Dieses Runbook beschreibt den Wiederherstellungs-Pfad.

> **Voraussetzung:** Das Backup-Tooling läuft regelmäßig
> (`pnpm backup:run`, idealerweise per Cron oder n8n täglich) und liefert
> erfolgreiche `BackupRecord`-Einträge. Audit-Archive werden wöchentlich
> vom Worker gerollt (siehe `audit-rotate`).

## 1. Was wird gesichert?

| Datenklasse | Wo liegt es? | Wie wird es gesichert? | Wie wird es wiederhergestellt? |
|---|---|---|---|
| Stammdaten + Bewegungsdaten | Postgres | täglicher `pg_dump --format=custom --compress=6` → Object-Store-Bucket `backups` | `pnpm backup:restore` (siehe Schritt 3) |
| Dokumente / Belege | Object-Store-Bucket `gobd` / `general` / `staff-private` | SeaweedFS-eigene Replikation/Backup (extern) | Object-Store-Restore aus extern |
| Audit-Log (aktuell) | Postgres `audit_log` | im pg_dump enthalten | mit pg_restore zurück |
| Audit-Archive (gerollt) | SeaweedFS `gobd/tenants/.../audit-archive/...ndjson` | Object-Lock COMPLIANCE 10 J. | bleibt erhalten — `verify:chain` rekonstruiert Chain |
| Tagesversiegelungen | Postgres `audit_seal` | im pg_dump enthalten | mit pg_restore zurück |
| Konfiguration (.env) | Datei am Server | außerhalb taxtronik (z. B. Ansible-Vault) | manuell |
| TLS-Zertifikate | Reverse-Proxy | außerhalb taxtronik | manuell |

## 2. Disaster-Szenarien

### 2.1 Postgres-Datenbank korrupt / gelöscht

→ Schritt 3 (pg_restore aus letztem SeaweedFS-Backup)

### 2.2 S3-Bucket beschädigt

→ Object-Store-Restore aus extern (Borg/Restic/Wasabi), dann `verify:chain` zur
   Integritätsprüfung

### 2.3 Server komplett verloren (Hardware-Schaden, Brand)

→ Alle Schritte: neuen Server provisionieren, Docker-Compose hochziehen,
   pg_restore + Object-Store-Restore, Smoke-Test

### 2.4 Ransomware / unautorisierte Änderung

→ Object-Lock COMPLIANCE schützt GoBD-Dokumente und Audit-Archive vor
   Verschlüsselung. pg_dump aus S3-Backup-Bucket einspielen, dann
   `verify:chain` — Hash-Chain-Bruch zeigt manipulierte Audit-Einträge auf.

## 3. Restore-Procedure (Postgres)

### Vorbereitung

Frische Postgres-Instanz hochziehen (z. B. via docker-compose, leere DB).
ENV-Variable `DATABASE_URL` auf das Restore-Ziel setzen.

### Schritt 3.1 — Verfügbare Backups listen

```bash
cd /opt/taxtronik
pnpm --filter @taxtronik/web exec tsx src/server/backup/restore.ts --list
```

Ausgabe (gekürzt):

```
Verfügbare Backups (12, neueste zuerst):
  2026-05-11T03:00:00.000Z  142.36 MB  pgdump/2026/05/11/taxtronik-20260511-0300.sql.gz
  2026-05-10T03:00:00.000Z  141.91 MB  pgdump/2026/05/10/taxtronik-20260510-0300.sql.gz
  …
```

### Schritt 3.2 — Restore (neueste Sicherung)

```bash
pnpm --filter @taxtronik/web exec tsx src/server/backup/restore.ts --latest
```

Wenn die Ziel-DB nicht leer ist (z. B. Teil-Schaden), explizit bestätigen:

```bash
pnpm --filter @taxtronik/web exec tsx src/server/backup/restore.ts --latest --confirm-overwrite
```

### Schritt 3.3 — Spezifische Sicherung wiederherstellen

```bash
pnpm --filter @taxtronik/web exec tsx src/server/backup/restore.ts \
  --key pgdump/2026/05/10/taxtronik-20260510-0300.sql.gz
```

### Schritt 3.4 — Smoke-Test

Nach dem Restore prüft das Skript automatisch (kann mit `--no-smoke-test`
übersprungen werden):

- Anzahl Tenants + Audit-Einträge erreichbar
- Letzten Audit-Eintrag mit Hash dargestellt

Zusätzlich manuell:

```bash
pnpm verify:chain
```

Erwartete Ausgabe:

```
=== Tenant default (Kanzlei XYZ) ===
  Audit-Einträge geprüft: 12345
  Tages-Stempel geprüft: 365
  ✓ Kette intakt
  Archiv-Segmente: 4
  ✓ Archiv 1-5000 (5000 Einträge, SOFT, 1234.5 KB)
  ✓ Archiv 5001-10000 (5000 Einträge, SOFT, 1289.7 KB)
  …
```

Bei Bruch zeigt die CLI die genaue Audit-ID und den Grund.

## 4. Restore-Procedure (SeaweedFS)

### Variante A: S3-Bucket-Replikation (empfohlen)

Konfiguration einer kontinuierlichen Replikation in einen Off-Site-SeaweedFS
oder S3-kompatiblen Cold-Storage (Wasabi, Backblaze). Doku:
[SeaweedFS Bucket Replication](https://min.io/docs/seaweedfs/linux/administration/bucket-replication.html).

Restore: über `mc mirror` aus dem Replikations-Ziel zurück.

### Variante B: Borg/Restic File-Level-Backup

Wenn Object-Store-Daten direkt auf dem Filesystem liegen (Single-Node-Deploy),
kann ein einfaches File-Backup mit `borg backup` oder `restic backup`
ausreichen. Restore: `borg extract` ins Daten-Verzeichnis.

> **Achtung:** Object-Lock-COMPLIANCE-Bestände dürfen NICHT überschrieben
> werden. Backup-Tools müssen nur lesen, nicht schreiben.

## 5. Audit-Chain-Rekonstruktion bei Datenverlust

Wenn aus Postgres nur ein Teil-Backup verfügbar ist (z. B. ältere Sicherung),
aber die Audit-Archive in SeaweedFS unbeschädigt sind, läuft die
Chain-Verifikation so:

1. pg_restore mit dem alten Backup → DB ist auf altem Stand
2. `verify:chain` läuft, prüft DB-Einträge bis zum letzten Eintrag
3. Für jedes Archive-Segment in SeaweedFS: Datei wird geladen, NDJSON gegen
   `firstPrevHash` und `lastThisHash` aus dem `audit_archive`-Datensatz
   verifiziert
4. Wenn die Datei mit `lastThisHash` des Archivs endet und der nächste
   DB-Eintrag mit diesem Wert als `prev_hash` beginnt, ist die Chain
   nahtlos

Ergebnis: Die GoBD-relevante Audit-Spur ist auch nach Teil-Datenverlust
beweisbar lückenlos, solange Object-Lock-Bestände erhalten sind.

## 6. RTO / RPO

| Metrik | Wert | Maßnahme |
|---|---|---|
| **RTO** (Wiederherstellungs-Zeit) | < 2 Stunden | pg_restore + Smoke-Test |
| **RPO** (akzeptabler Datenverlust) | < 24 Stunden | tägliches Backup |
| Audit-Log-Verlust (worst case) | 0 (für rotierte Segmente) | Object-Lock COMPLIANCE 10 J. |

## 7. Backup-Test-Routine (empfohlen)

Mindestens vierteljährlich:

1. Frische Postgres-Instanz (Test-Container) hochziehen
2. `restore.ts --latest --target-url postgres://test/test --no-smoke-test`
3. `pnpm verify:chain` gegen Test-DB → muss durchlaufen
4. Manueller Login mit einem Test-Account → muss funktionieren
5. Ergebnis in der DSGVO-Verarbeitungs-Doku als Wiederherstellungs-Test
   dokumentieren

## 8. Checkliste „Server kompletter Neuaufbau"

- [ ] Frische VM/Server bereitgestellt
- [ ] Docker + Compose installiert
- [ ] taxtronik-Repo auskucheckt, korrekte Version (siehe `APP_VERSION` aus letztem Backup)
- [ ] `.env` aus Backup-Vault wiederhergestellt
- [ ] `docker compose up -d postgres redis seaweedfs clamav` (Infra)
- [ ] `pnpm install`
- [ ] `pnpm db:migrate:deploy` (DB-Schema bauen)
- [ ] `pnpm --filter @taxtronik/web exec tsx src/server/backup/restore.ts --latest`
- [ ] `pnpm verify:chain` läuft sauber durch
- [ ] Object-Store-Daten aus externem Backup zurückgespielt
- [ ] App + Worker starten: `pnpm dev` (oder Production-Setup)
- [ ] Manueller Login + Test der wichtigsten Module
- [ ] Wiederherstellung in DSGVO-Verarbeitungsverzeichnis vermerken
