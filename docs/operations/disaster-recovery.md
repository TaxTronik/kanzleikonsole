# Disaster-Recovery-Runbook

Was tun, wenn die taxtronik-Installation einer Kanzlei beschädigt ist oder
ausfällt? Dieses Runbook beschreibt den Wiederherstellungs-Pfad.

> **Voraussetzung:** Der Worker erzeugt täglich um 01:00 UTC einen vollständigen
> Dump direkt im S3-Backup-Bucket und liefert erfolgreiche `BackupRecord`-
> Einträge. `./taxtronik backup` erzeugt bei Bedarf einen zusätzlichen
> manuellen Dump in S3 **und** lokal unter `backups/` bzw.
> `BACKUP_LOCAL_DIR`. Der automatische
> Tagesjob besitzt dagegen keine lokale Kopie. Audit-Archive werden wöchentlich
> vom Worker gerollt (siehe `audit-rotate`).
>
> Wichtig: Das Postgres-Backup enthält Dokument-Metadaten und Storage-Keys,
> aber nicht die Datei-Bytes der Kanzleidokumente. Diese liegen in SeaweedFS.

## 1. Was wird gesichert?

| Datenklasse                 | Wo liegt es?                                                     | Wie wird es gesichert?                                                                                               | Wie wird es wiederhergestellt?                         |
| --------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Stammdaten + Bewegungsdaten | Postgres                                                         | täglicher Worker-`pg_dump --format=custom --compress=6` → Bucket `backups`; manuelle Operator-Läufe zusätzlich lokal | `./taxtronik restore` (siehe Schritt 3)                |
| Dokumente / Belege          | Object-Store-Bucket `gobd` / `gwg` / `general` / `staff-private` | `backup-full` mit quiesziertem SeaweedFS-Cold-Snapshot; `backup-files` nur zusätzliche Byte-Kopie                    | Cold-Volume-Restore aus verschlüsseltem Offsite-Backup |
| Audit-Log (aktuell)         | Postgres `audit_log`                                             | im pg_dump enthalten                                                                                                 | mit pg_restore zurück                                  |
| Audit-Archive (gerollt)     | SeaweedFS `gobd/tenants/.../audit-archive/...ndjson`             | Object-Lock COMPLIANCE 10 J.                                                                                         | bleibt erhalten — `verify:chain` rekonstruiert Chain   |
| Tagesversiegelungen         | Postgres `audit_seal`                                            | im pg_dump enthalten                                                                                                 | mit pg_restore zurück                                  |
| Konfiguration (.env)        | Datei am Server                                                  | außerhalb taxtronik (z. B. Ansible-Vault)                                                                            | manuell                                                |
| TLS-Zertifikate             | Reverse-Proxy                                                    | außerhalb taxtronik                                                                                                  | manuell                                                |

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
regulärem Überschreiben. Der Bucket `backups` selbst hat jedoch nur eine
90-Tage-Lifecycle-Regel, kein Object Lock und keine anwendungsseitige
Verschlüsselung. Eine vom Produktivsystem getrennte, verschlüsselte und
unveränderbare Off-Site-Kopie ist deshalb Pflicht. Danach `verify:chain`
ausführen — ein Hash-Chain-Bruch zeigt manipulierte Audit-Einträge auf.

## 3. Restore-Procedure (Postgres)

### Vorbereitung

Frische Postgres-Instanz hochziehen (z. B. via docker-compose, leere DB).
Jeder mutierende Restore verlangt entweder ein explizites `--target-url` oder
den gesondert bestätigten `--production-target`-Pfad. Einen impliziten Fallback
auf die produktive `DATABASE_URL` aus `.env` gibt es nicht.

Der Dump enthält PostgreSQL-ACLs und sicherheitsrelevante REVOKEs. Die
clusterweite Rolle `taxtronik_app` muss deshalb **vor** `pg_restore` aus der
gesicherten `.env` angelegt/synchronisiert sein. Der Operator-Wrapper
`./taxtronik restore` erledigt dies; ein direkter Aufruf von `restore.ts`
bricht ohne die Rolle ab.

Die S3-CLI vergleicht den Dump-Hash mit `BackupRecord`, solange die bisherige
Produktiv-DB noch lesbar ist. Nach vollständigem DB-Verlust ist genau diese
Referenz nicht verfügbar; der Restore warnt dann und fährt fort. Deshalb muss
der Off-Site-Prozess Hash/Größe/Key in einem getrennten, unveränderbaren oder
signierten Manifest sichern. Ein Hash, der nur zusammen mit dem Dump oder in
derselben verlustbetroffenen DB liegt, ist kein ausreichender DR-Nachweis.

### Schritt 3.1 — Verfügbare Backups listen

```bash
cd /opt/taxtronik
./taxtronik restore --list
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
./taxtronik restore --latest --target-url postgresql://taxtronik:...@localhost:5432/taxtronik_restore
```

Wenn die Ziel-DB nicht leer ist (z. B. Teil-Schaden), explizit bestätigen:

```bash
./taxtronik restore --latest \
  --target-url postgresql://taxtronik:...@localhost:5432/taxtronik_restore \
  --confirm-overwrite
```

### Schritt 3.3 — Spezifische Sicherung wiederherstellen

```bash
./taxtronik restore \
  --key pgdump/2026/05/10/taxtronik-20260510-0300.sql.gz \
  --target-url postgresql://taxtronik:...@localhost:5432/taxtronik_restore
```

### Schritt 3.4 — Lokale Kopie statt S3

Wenn der lokale Dump aus `backups/` bzw. `BACKUP_LOCAL_DIR` genutzt werden
soll, läuft der Restore bewusst ohne S3-Preflight:

```bash
./taxtronik restore \
  --file /opt/taxtronik/backups/taxtronik-20260510-0300.dump \
  --target-url postgresql://taxtronik:...@localhost:5432/taxtronik_restore
```

### Schritt 3.5 — In-place-Produktionsrestore (nur DR)

Nur wenn ein isolierter Restore nicht genügt, darf die konfigurierte
Produktivdatenbank explizit gewählt werden:

```bash
./taxtronik restore --latest \
  --production-target \
  --confirm-overwrite \
  --confirm-production-restore RESTORE_TAXTRONIK_PRODUCTION_DATABASE \
  --release-version 1.2.3
```

Der Wrapper stoppt App, Worker und n8n vor `pg_restore`, verifiziert deren
Stillstand und lässt alle drei Dienste auch bei Fehler oder Erfolg gestoppt.
`--release-version` ist die explizite Betreiberbestätigung, zu welchem
Release-Vertrag das gewählte Backup gehört. Noch vor der Restore-Mutation wird
`.taxtronik.database-restored` mit Status `pending` angelegt. Ein Fehler lässt
diese persistente Writer-Sperre bestehen; nur ein vollständig erfolgreicher
Restore setzt den Status auf `ready`.

Nach dem Restore zuerst Audit-Chain, RLS/Rollen und Migrationsstand prüfen;
anschließend aktiviert `./taxtronik rollback 1.2.3` genau diesen einmalig
autorisierten, signierten Release-Vertrag. Das Rollback-Kommando startet
App/Worker/n8n selbst und entfernt die Autorisierung erst nach bestandenem
Health-/Readiness-Gate. Die Zielversion darf nach einem Restore nicht
weggelassen oder abweichend angegeben werden. `./taxtronik up`, `restart`,
`backup-full` und `deploy`/`update` bleiben bis dahin gesperrt. Direkte
`docker compose`-Aufrufe liegen außerhalb des CLI-Guards und sind in diesem
Zustand ausdrücklich verboten; den Marker nicht manuell löschen.

### Schritt 3.6 — Smoke-Test

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

### Bevorzugt: versiegeltes Full-Backup (Single-Node)

`./taxtronik backup-full` erzeugt einen gemeinsamen Recovery Point: Während
App, Worker und n8n gestoppt sind, werden beide Postgres-Datenbanken und die
sichtbaren Bucket-Bytes gesichert; danach folgen Cold-Snapshots von
`seaweed_data`, `redis_data` und `n8n_data`. Die gesamte Nutzlast einschließlich
`.env` wird als `full-backup.tar.age` verschlüsselt. Daneben liegen nur das
Ed25519-signierte SHA-256-Manifest und seine Signatur.

Auf einem frischen, isolierten Restore-System (Produktiv-`.env` ist noch nicht
nötig):

```bash
./taxtronik backup-verify /vault/full/<id> /offline/backup-manifest-public.pem
./taxtronik backup-decrypt /vault/full/<id> /restore/<id> \
  /offline/age-identity.txt /offline/backup-manifest-public.pem
```

`backup-decrypt` verweigert nicht-leere Ziele, prüft vorab Signatur und alle
Hashes und testet anschließend die drei Volume-TARs strukturell. Danach enthält
`/restore/<id>` unter anderem:

```text
.env
database/                       # taxtronik- und n8n-Custom-Dumps
object-store-byte-export/       # sichtbare Bytes als Notfallquelle
volumes/
  seaweedfs-data.tar.gz         # inkl. Versionen/Delete Marker/Lock-Metadaten
  redis-data.tar.gz
  n8n-data.tar.gz
```

Die Named Volumes ausschließlich in einer **leeren isolierten Installation**
rehydrieren. Zielvolumen zuerst explizit ermitteln (`docker inspect … .Mounts`),
Leere prüfen und dann mit dem gepinnten Alpine-Image entpacken; niemals über
ein bestehendes Produktivvolume schreiben:

```bash
docker run --rm \
  -v <leeres-seaweed-volume>:/target \
  -v /restore/<id>/volumes:/backup:ro \
  alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc \
  sh -ec 'test -z "$(ls -A /target)"; tar -xzf /backup/seaweedfs-data.tar.gz -C /target'
```

Für `redis-data.tar.gz` und `n8n-data.tar.gz` analog. Anschließend
Postgres-Infrastruktur mit der wiederhergestellten `.env` starten, den
TaxTronik-Dump über `./taxtronik restore --file … --target-url …` und den
n8n-Dump per `pg_restore --single-transaction --exit-on-error` einspielen.
Erst danach App/Worker/n8n starten. Pflichtprüfungen: `restore-selftest`/
Audit-Chain, App-Health + Deploy-Readiness, Login, n8n-Credential-Entschlüsselung,
Dokument-Download sowie Stichproben von VersionId/Retention/Delete Markern.

Das Verfahren stellt Werkzeuge und eine versionstreue Cold-Quelle bereit. Eine
belastbare Wiederanlaufgarantie entsteht erst durch den unten beschriebenen
isolierten Vollsystem-Drill auf der realen Betreiber-Infrastruktur.

### Variante 0: Lokaler Bucket-Export (`backup-files`)

Für kleine Single-Node-Installationen kann zusätzlich zum DB-Backup eine
lokale Byte-Kopie der Kanzleidateien erzeugt werden:

```bash
./taxtronik backup-files
```

Ziel:

```text
backups/
  object-store/
    20260618-013000/
      gobd/
      gwg/
      general/
      staff-private/
      manifest.txt
```

Restore in frisch initialisierte Buckets (nach `seaweedfs-init`):

```bash
set -a
. ./.env
set +a

docker run --rm --network taxtronik \
  -e AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
  -e AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
  -e AWS_DEFAULT_REGION="${S3_REGION:-us-east-1}" \
  -v "$PWD/backups/object-store/20260618-013000:/backup:ro" \
  amazon/aws-cli:latest@sha256:c95ab0642137f55a12b95b6956dd03cefdbd73e760e0e7b870afc9b47f9c8150 \
  --endpoint-url http://seaweedfs:8333 s3 sync /backup/gobd s3://gobd --only-show-errors
```

Für `gwg`, `general` und `staff-private` analog wiederholen.

Grenze: Dieser Export ist eine Datei-Byte-Kopie. Er erhält nicht zuverlässig
alle Object-Lock-/Versioning-Metadaten des Object-Stores. Für GoBD-/GwG-
Nachweistreue ist zusätzlich Variante A oder B Pflicht.

> **Wichtig seit persistierter `storageVersionId`:** `backup-files`/`aws s3
sync` kopiert nur
> die sichtbaren Bytes, nicht die bisherigen S3-Version-IDs oder verdeckte
> Versionen hinter Delete Markern. Beim Rückspielen entstehen neue Version-IDs
> und durch Bucket-Defaults gegebenenfalls neue Retention-Zeiträume. Die in
> `document_version.storage_version_id` gespeicherten IDs passen danach nicht
> mehr. Variante 0 ist daher nur eine Notfall-Bytequelle, kein rechtssicherer
> 1:1-Restore. Ein Einsatz erfordert eine inventarisierte Zuordnung auf die neu
> erzeugten Versionen, fachliche Prüfung der Retention und einen kontrollierten
> DB-Backfill. Legacy-Zeilen mit NULL-VersionId sowie alte Delete Marker müssen
> separat inventarisiert werden.

### Variante A: SeaweedFS-Backup auf getrennten Cluster (empfohlen)

SeaweedFS dokumentiert Offline-/Snapshot-Verfahren unter
[Data Backup](https://github.com/seaweedfs/seaweedfs/wiki/Data-Backup) und
einen laufenden zweiten SeaweedFS-Zielcluster unter
[Async Backup](https://github.com/seaweedfs/seaweedfs/wiki/Async-Backup).
Das konkrete Verfahren muss gegen die eingesetzte SeaweedFS-Version getestet
werden. Weder ein generischer S3-Mirror noch bloße Filer-Replikation darf ohne
Restore-Nachweis als Garantie für S3-Version-IDs, Delete Marker und
Object-Lock-Retention dokumentiert werden.

Restore: nach dem gewählten SeaweedFS-Verfahren in einen isolierten Zielcluster;
danach Versionen, Retention und Stichproben-Downloads prüfen, bevor die App auf
den Zielcluster umgeschaltet wird.

### Variante B: Borg/Restic File-Level-Backup

Wenn Object-Store-Daten direkt auf dem Filesystem liegen (Single-Node-Deploy),
kann ein vollständiger Snapshot des gesamten `seaweed_data`-Volumes eine
Option sein. Eine Dateikopie während laufender Schreibvorgänge ist nicht
automatisch konsistent; SeaweedFS muss nach dem gewählten offiziellen
Backup-Verfahren quiesziert/gestoppt oder der Volume-Snapshot nachweislich
crash-konsistent erstellt werden. Restore zunächst isoliert und gegen S3-
Versionen/Object-Lock-Metadaten prüfen.

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

| Metrik           | Wert                                                      | Maßnahme                                                                                        |
| ---------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **DB-RTO-Ziel**  | < 2 Stunden                                               | Nur Postgres-Restore + Smoke-Test; noch keine gemessene Vollsystem-Garantie                     |
| **DB-RPO-Ziel**  | < 24 Stunden                                              | Gilt nur bei erfolgreichem täglichem Worker-Backup und externem Monitoring                      |
| **Dokument-RPO** | Betreiberabhängig                                         | Zeitpunkt des letzten erfolgreichen, offsite bestätigten Full-Backups bzw. externer Replikation |
| Audit-Archive    | 0 nur für erfolgreich extern erhaltene, rotierte Segmente | Object Lock schützt nicht gegen Verlust des gesamten lokalen Storage-Standorts                  |

RTO und RPO sind Zielwerte. Ein belastbarer SLA-Wert entsteht erst aus
protokollierten Vollsystem-Drills einschließlich Entschlüsselung, Cold-Volume-
Rehydrate, Dokument-Store, `.env`/Keys, n8n und Anmeldung. Der automatische
Worker-/CI-Drill prüft weiterhin nur Postgres und Audit-Chain; er ersetzt den
Betreiber-Vollsystem-Drill nicht.

## 7. Backup-Test-Routine (empfohlen)

Mindestens vierteljährlich auf einem vollständig isolierten Zielhost:

1. Neueste Offsite-Version anhand Receipt/VersionId beziehen; Manifest mit dem
   offline Public Key prüfen und mit der offline age-Identity entschlüsseln.
2. Leere Named Volumes anlegen und alle drei Cold-Snapshots rehydrieren.
3. TaxTronik- und n8n-Dump in eine frische Postgres-Instanz einspielen.
4. Exakt die im Manifest gebundene Release-Version starten.
5. `pnpm verify:chain`, Health und Deploy-Readiness ausführen.
6. Manueller Login, n8n-Credential-Test, Dokument-Download sowie
   VersionId-/Retention-/Delete-Marker-Stichprobe durchführen.
7. Gemessene RTO, Recovery-Point-Zeit, Abweichungen und Verantwortliche in der
   DSGVO-/GoBD-Verfahrensdokumentation ablegen.
8. Entschlüsseltes Staging und Drill-Secrets nach Freigabe sicher beseitigen.

Der Lauf gilt nur als bestanden, wenn alle Schritte erfolgreich waren. Eine
reine `backup-verify`-/TAR-Strukturprüfung ist noch kein Restore-Drill.

Zusätzlich kann für häufigere DB-only-Prüfungen eine frische
Postgres-Instanz genutzt werden:

1. `./taxtronik restore --latest --target-url postgres://test/test --no-smoke-test`
2. `pnpm verify:chain` gegen Test-DB
3. Ergebnis als eingeschränkten **DB-Drill** (nicht Vollsystem) eindeutig
   dokumentieren

### 7.1 Automatisierter Restore-Selbsttest (CI)

Zusätzlich zum vierteljährlichen manuellen Test läuft bei jedem CI-Durchlauf
ein automatisierter Backup→Restore-Roundtrip (Job `restore` in
`.forgejo/workflows/ci.yml`, nach dem `db`-Job). Er fährt den ECHTEN
Code-Pfad — kein Parallel-Reimplementat:

1. `runner.ts --out-file` erzeugt einen `pg_dump` (identische Flags wie das
   Produktiv-Backup) der migrierten + geseedeten Quell-DB als lokale Datei.
2. `restore.ts --file` spielt diese Datei via `pg_restore` (identische Flags,
   `--single-transaction --exit-on-error`, Smoke-Test) in eine frische
   Ziel-DB `taxtronik_restore` ein.
3. **Assertion A:** Zeilenzahl-Vergleich Quelle ↔ Ziel für die wichtigsten
   Tabellen (`tenant`, `audit_log`, `client`, `document`, `invoice`).
4. **Assertion B:** Verbindung als `taxtronik_app`, RLS sowie kritische
   Grants/REVOKEs auf Audit-Tabellen und GwG-SECURITY-DEFINER-Funktionen.
5. **Assertion C (compliance-kritisch):** `verify:chain` auf der
   wiederhergestellten DB — die Audit-Hash-Chain MUSS intakt sein.

> Hinweis: `pg_restore --clean --if-exists` in eine frische DB erzeugt
> harmlose Notices (`DROP … IF EXISTS` auf noch nicht existente Objekte). Das
> ist normal; nur echte Fehler brechen den Restore via `--exit-on-error`.

**Lokal ausführen** (gegen eine Dev- oder Test-DB; legt `taxtronik_restore`
temporär an und droppt sie wieder):

```bash
DATABASE_URL=postgresql://taxtronik:…@localhost:5432/taxtronik \
DATABASE_APP_URL=postgresql://taxtronik_app:…@localhost:5432/taxtronik \
  bash scripts/restore-selftest.sh
```

**Air-Gapped-/manuelle Sicherung:** Der `--out-file`/`--file`-Modus taugt auch
für Backups ohne Object-Store. Dump exportieren, Datei auf ein getrenntes
Medium transferieren, später per `--file` wiederherstellen:

```bash
# Export (kein S3, kein BackupRecord, reiner Dump):
pnpm --filter @taxtronik/web exec tsx src/server/backup/runner.ts \
  --out-file /sicher/taxtronik.dump

# Restore aus der lokalen Datei (DB-Hash-Verifikation entfällt — Datei-Quelle):
./taxtronik restore --file /sicher/taxtronik.dump \
  --target-url postgresql://taxtronik:...@localhost:5432/taxtronik_restore \
  --confirm-overwrite
```

## 8. Checkliste „Server kompletter Neuaufbau"

- [ ] Frische VM/Server bereitgestellt
- [ ] Docker + Compose installiert
- [ ] taxtronik-Repo ausgecheckt; `TAXTRONIK_VERSION` aus der gesicherten `.env`
      pinnt das passende Release-Image (Registry-Modus: kein Build nötig)
- [ ] Full-Backup mit offline Public Key verifiziert und mit offline age-Identity
      in ein leeres, geschütztes Ziel entschlüsselt
- [ ] `.env` aus dem verschlüsselten Backup wiederhergestellt
- [ ] Leere `seaweed_data`-/`redis_data`-/`n8n_data`-Volumes aus Cold-Snapshots
      rehydriert; Version-/Retention-Stichprobe vorbereitet
- [ ] `docker compose up -d postgres redis seaweedfs clamav` (Infra)
- [ ] `pnpm install`
- [ ] `pnpm db:migrate:deploy` (DB-Schema bauen)
- [ ] `./taxtronik restore --latest --target-url <postgres-url>`
- [ ] n8n-DB-Dump eingespielt; n8n-Volume und `N8N_ENCRYPTION_KEY` gehören zum
      gleichen Recovery Point
- [ ] SeaweedFS-Cold-Snapshot gestartet; Byte-Export nur als Notfallalternative
- [ ] `pnpm verify:chain` läuft sauber durch
- [ ] App + Worker starten: `pnpm dev` (oder Production-Setup)
- [ ] Manueller Login + Test der wichtigsten Module
- [ ] Wiederherstellung in DSGVO-Verarbeitungsverzeichnis vermerken

## 9. Rollback auf eine vorherige Version

Vollständiger Prozess inkl. Expand/Contract-Konvention:
[release.md](release.md). Kurzfassung:

### 9.1 Nur App zurück (keine Migrationen seit dem letzten Update)

```bash
# Automatisch auf den vorherigen Stand (aus .taxtronik.state) zurueck:
./taxtronik rollback
# Oder explizit auf einen signierten früheren Release-Vertrag:
./taxtronik rollback <vorherige-version>
```

Registry-Images sind versioniert — das ist ein reiner Re-Pin, die Datenbank
bleibt unangetastet. Dank Expand/Contract-Konvention verträgt die N-DB den
N−1-Code.

### 9.2 Rollback über Migrationen hinweg (letzte Option)

`./taxtronik deploy`/`update` legen vor jeder Migration automatisch ein Backup an
(Skip nur beim Erstdeploy). Pfad zurück:

1. Backup von **vor** der Migration einspielen (Abschnitt 3; bei gefüllter
   Produktiv-DB ausschließlich mit `--production-target`, exakter
   Produktionsbestätigung, `--confirm-overwrite` und passender
   `--release-version`)
2. `./taxtronik rollback <vorherige-version>` explizit ausführen; die CLI prüft Tag,
   Commit sowie Web- und Worker-Digest gemeinsam und startet keine Migration
3. `pnpm verify:chain` — Audit-Kette muss intakt sein

> **Achtung:** Alle Daten, die nach dem Backup entstanden sind, gehen
> verloren. Vorher prüfen, ob ein Fix-Forward (Patch-Release) der bessere Weg
> ist.

## Volume-Inventar & Backup-Status

| Volume / DB          | Inhalt                                         | Backup                                                        |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| Postgres `taxtronik` | App-Daten (Mandanten, Rechnungen, Audit-Chain) | `backup` (DB-only) und quiesziertes `backup-full`             |
| Postgres `n8n`       | n8n-Credentials + Ausführungshistorie          | quieszierter Custom-Dump im `backup-full`                     |
| `seaweed_data`       | GoBD-/GwG-Objekte inkl. Store-Metadaten        | Cold-Volume-Snapshot im `backup-full`; Byte-Export zusätzlich |
| `n8n_data`           | n8n-Config inkl. `encryptionKey`               | Cold-Volume-Snapshot im gleichen `backup-full`                |
| `redis_data`         | BullMQ-Queues (AOF)                            | Cold-Volume-Snapshot im gleichen `backup-full`                |
| `clamav_data`        | Virensignaturen                                | bewusst NICHT gesichert (Auto-Download)                       |
| `eric_logs`          | ERiC-Protokolle (Lizenzpflicht)                | Volume-Snapshot beim Betreiber                                |

Wiederherstellung n8n: Volume `n8n_data` + Postgres-`n8n`-Dump zusammen
einspielen; `N8N_ENCRYPTION_KEY` in der `.env` muss zum gesicherten Stand passen
(sonst sind die Credentials unentschlüsselbar).
