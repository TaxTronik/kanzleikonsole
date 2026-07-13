# Day-2 Operations

Dieses Runbook beschreibt den laufenden Betrieb nach der Erstinstallation.
Erstinstallation und Release-Wechsel stehen in
[`release.md`](release.md), Restore in
[`disaster-recovery.md`](disaster-recovery.md).

## Zielbild

- Betreiber kann jederzeit erkennen, welcher Stand läuft.
- Backups sind nicht nur vorhanden, sondern regelmäßig wiederhergestellt.
- Speicherverbrauch wächst kontrolliert.
- SMTP, n8n, Risk-Layer und Reverse Proxy sind als Betriebsschnittstellen klar
  überwacht.
- Störungen führen zu einem konkreten Handgriff, nicht zu Rätselraten.

## Tägliche Sichtprüfung

```bash
./taxtronik ps
./taxtronik doctor
./taxtronik logs app --tail 80
./taxtronik logs worker --tail 80
```

Erwartung:

- `doctor` zeigt keine `FEHLT`-Zeilen.
- `app`, `worker`, `n8n`, `postgres`, `redis`, `seaweedfs`, `clamav` laufen.
- Keine wiederholten `SYSTEM_AUDIT_BREAK`, Restore-, SMTP- oder n8n-HMAC-Fehler.

## Wöchentliche Routine

1. Security-Workflow in Forgejo prüfen (`security.yml`): Dependency-Audit und
   Secret-Scan müssen grün sein.
2. Letzten erfolgreichen CI-Lauf zu `main` prüfen: `quality`, `db`, `restore`,
   `e2e-smoke`, `e2e-paranoid`.
3. Backup-Status in der Admin-Oberfläche prüfen: letzter Lauf `SUCCESS`,
   Größe plausibel, SHA-256 vorhanden.
4. Speicher prüfen:

```bash
docker system df
docker builder du
```

Lokale Builds räumen ungenutzten BuildKit-Cache nach jedem Build automatisch
auf (`TAXTRONIK_BUILD_CACHE_PRUNE_UNTIL`, Default `168h`). Wenn der Server
trotzdem wächst:

```bash
docker builder prune --force --filter "until=168h"
```

Keine Volumes löschen, solange kein Restore-/Migrationsplan vorliegt.

## Monatliche Routine

1. Restore-Drill ausführen oder den automatischen Drill-Nachweis prüfen.
2. `pnpm verify:chain` gegen den aktuellen Stand ausführen.
3. SMTP-Test-Mail aus der Admin-Konfiguration auslösen.
4. n8n-Credentials und Workflow-Import prüfen.
5. Reverse-Proxy-Zertifikate und Ablaufdaten prüfen.
6. Freien Plattenplatz, Docker-Volumes und Backup-Bucket-Retention prüfen.

## Updates

Vor jedem Update:

```bash
./taxtronik doctor
./taxtronik backup
```

Das manuell gestartete Backup ist der zusätzliche Betreiber-Nachweis. Auch
`./taxtronik update` selbst erzwingt unmittelbar vor jeder Codeänderung ein
weiteres Backup mit dem noch installierten Release.

`./taxtronik backup` schreibt den Dump zuerst lokal unter `backups/` (bzw.
`BACKUP_HOST_DIR`/`BACKUP_LOCAL_DIR`) und lädt dieselbe Datei danach in den
S3-Backup-Bucket. Zusätzlich streamt der Worker täglich um 01:00 UTC einen
Dump direkt nach S3; dieser Tagesjob erzeugt keine lokale Kopie. Der manuelle
Lauf kann in einer Single-Tenant-Installation auch in der Admin-Übersicht
gestartet werden. Vollständige Datenbank-Dumps sind dort absichtlich nicht
herunterladbar; Download und Restore bleiben Operator-Aufgaben am Host/S3.

Die normalen DB-Dumps aus `backup`/Tagesjob werden von TaxTronik nicht selbst
verschlüsselt. `backups` hat eine 90-Tage-Lifecycle-Regel, aber keinen Object
Lock. Für einen verschlüsselten, zusammenhängenden Wiederanlaufpunkt dient
deshalb `backup-full` (unten); DB-only-Sicherungen benötigen weiterhin ein
verschlüsseltes Betreiber-Dateisystem bzw. extern verschlüsselte Replikation.

Die Kanzleidateien selbst liegen nicht in Postgres, sondern in SeaweedFS.
Zusätzlich sichern:

```bash
./taxtronik backup-files   # Datei-Buckets nach backups/object-store/<timestamp>
./taxtronik backup-full    # konsistentes, verschlüsseltes und signiertes Full-Backup
```

`backup-full` ist bewusst ein Wartungsfenster: Ein globaler Lock verhindert
parallele Läufe; App, Worker und n8n werden vor DB-Dumps und Object-Export
gestoppt. Anschließend werden `seaweed_data`, `redis_data` und `n8n_data` cold
gesichert. Erst nach gemeinsamer age-Verschlüsselung, Löschen des
Klartext-Stagings und Ed25519-Signatur/SHA-256-Inventar starten die
Schreibdienste wieder. Ein Kapazitäts-Preflight rechnet konservativ ohne
Kompressionsgewinn. Abbruchsignale lösen Wiederanlauf und Staging-Cleanup aus;
ein Host-Crash muss dennoch extern überwacht werden.

Einrichten (Private Keys/age-Identity getrennt bzw. offline verwahren):

```bash
node scripts/backup/manifest.mjs generate-key --out-dir /sicher/offline
# BACKUP_AGE_RECIPIENT, BACKUP_MANIFEST_PRIVATE_KEY_FILE und
# BACKUP_MANIFEST_PUBLIC_KEY_FILE gemäß .env.example setzen
```

Ist ein getrennt administriertes `BACKUP_OFFSITE_*`-Ziel konfiguriert, lädt
`backup-full` die drei Artefakte automatisch hoch. Zulässig sind nur HTTPS,
Bucket-Versioning und Default Object Lock **COMPLIANCE** mit mindestens
`BACKUP_OFFSITE_MIN_RETENTION_DAYS` (Default 90). Größe, Retention und
VersionId jedes Objekts werden geprüft und in einem lokalen Offsite-Receipt
festgehalten. Mit `BACKUP_OFFSITE_REQUIRED=true` gilt eine nur lokale Sicherung
als Fehler.

Verifikation und Entschlüsselung funktionieren auf einem frischen
Restore-System auch ohne vorhandene Produktiv-`.env`:

```bash
./taxtronik backup-verify backups/full/<id> /offline/backup-manifest-public.pem
./taxtronik backup-decrypt backups/full/<id> /restore/staging \
  /offline/age-identity.txt /offline/backup-manifest-public.pem
```

`backup-files` bleibt eine praktische Byte-Kopie, bewahrt für sich aber keine
S3-Version-IDs, Delete Marker oder Retention-Metadaten. Im Full-Backup liefert
der zusätzliche Cold-Snapshot des kompletten SeaweedFS-Volumes die
versionstreue Quelle; ihr tatsächlicher Wiederanlauf muss im isolierten
Vollsystem-Drill nach dem DR-Runbook geprüft werden.

Restore läuft über den Operator-Wrapper:

```bash
./taxtronik restore --list
./taxtronik restore --latest --target-url <postgres-url>
./taxtronik restore --file backups/<dump> --target-url <postgres-url>
```

Dann:

```bash
./taxtronik update
```

Das Update löst im Registry-Modus zuerst das Ed25519-signierte Manifest für die
Zielversion auf. Erst nach dem Pflichtbackup mit altem Checkout wird exakt der
annotierte `vX.Y.Z`-Tag geholt und per `ff-only` auf den signierten Commit
gebracht. Web und Worker werden als getrennte `image:tag@sha256:…`-Referenzen
gezogen; OCI-Version/Revision müssen zum Manifest passen. Mutable Tags oder ein
abweichender Checkout werden verweigert. Danach folgen Migration, Start,
strikter Health-Smoke (`degraded` ist Fehler) und Deploy-Readiness ohne
Skip-Pfad. Kein `git reset --hard`: Lokale Abweichungen müssen bewusst
aufgelöst werden.

Die Operator-CLI setzt für neu erzeugte Dateien `umask 077` und härtet `.env`
auf Modus `0600`. Eine hostseitige `seaweedfs-s3.generated.json` gibt es nicht
mehr: SeaweedFS rendert die Konfiguration beim Containerstart flüchtig unter
`/run` als UID 1000 mit Modus `0400`. Historische generierte Dateien werden
entfernt. Die CLI muss unter dem Dateieigentümer des Deployment-Checkouts
ausgeführt werden.

## SMTP

Mailhog ist nur Dev. Produktion benötigt ein echtes SMTP-Relay:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_FROM`
- optional `SMTP_USER` / `SMTP_PASSWORD`

`./taxtronik doctor` blockt `mailhog` und `localhost:1025`/`127.0.0.1:1025`.
Bei Mail-Ausfall:

1. `doctor` ausführen.
2. SMTP-Test-Mail auslösen.
3. Worker-Logs prüfen: `./taxtronik logs worker --tail 120`.
4. Relay-Logs beim Betreiber prüfen.

## n8n

n8n ist Produktionsbestandteil, Mailhog nicht. n8n läuft intern im Compose-Netz
und ruft App-Endpunkte per HMAC auf.

Prüfen:

- `N8N_HMAC_SECRET` ist in App/Worker/n8n identisch.
- `N8N_ENCRYPTION_KEY` passt zum bestehenden n8n-Volume.
- `TAXTRONIK_API_URL` zeigt intern auf App oder bewusst auf den Proxy.

Bei HMAC-Fehlern: Secrets nicht blind neu generieren. Erst prüfen, ob n8n noch
ein altes Volume mit anderem Encryption Key nutzt.

## Risk-Layer

`RISK_LAYER_URL` ist ein explizites Operator-Backend-Ziel. Interne IPs,
Loopback und Docker-Service-DNS sind erlaubt, ohne `INTERNAL_FETCH_HOSTS` zu
erweitern.

Bei Docker gilt: `127.0.0.1`/`localhost` zeigt aus Sicht von `taxtronik-app`
auf den App-Container selbst. Fuer den Compose-Risk-Layer daher
`http://risk-layer:8000` verwenden; bei separat laufender Engine eine aus dem
App-Container erreichbare interne Host-IP oder DNS-Adresse setzen.

Pflichtpaar:

- `RISK_LAYER_URL`
- `RISK_LAYER_TOKEN`

Bei Fehlern:

1. `./taxtronik doctor` prüfen.
2. Erreichbarkeit vom App-Container aus prüfen.
3. Tokenlänge und Bearer-Konfiguration prüfen.
4. Risk-Layer-Logs getrennt vom TaxTronik-Stack auswerten, wenn er separat
   betrieben wird.

## Incident-Kurzpfad

| Signal                   | Sofortmaßnahme                          | Danach                                                 |
| ------------------------ | --------------------------------------- | ------------------------------------------------------ |
| Audit-Chain-Bruch        | Schreibzugriffe stoppen, Backup sichern | `verify:chain` Report sichern, Ursache isolieren       |
| Restore fehlgeschlagen   | Keine weiteren Migrationen              | letztes intaktes Backup suchen, `disaster-recovery.md` |
| SMTP down                | Betreiber informieren, Relay prüfen     | Test-Mail, Worker-Logs                                 |
| n8n HMAC invalid         | Webhooks pausieren                      | Secret-/Volume-Abgleich                                |
| Speicher fast voll       | Builds stoppen, `docker system df`      | Build-Cache prune, Log-Rotation prüfen                 |
| Verdacht auf Secret-Leak | Sessions invalidieren                   | [`secret-rotation.md`](secret-rotation.md)             |

## Nachweise ablegen

Für prüfungsnahe Betreiber sollten diese Artefakte revisionssicher abgelegt
werden:

- CI-Testberichte (`testbericht-unit`, `testbericht-ops`, `testbericht-db`,
  `testbericht-restore`, Playwright-Reports)
- Security-Workflow-Artefakte
- Restore-Drill-Protokolle
- Release-Tag, Commit-SHA, Image-Digests
- Changelog-Abschnitt des ausgelieferten Tags

## Externe Überwachung & Auto-Restart (Pflicht)

Der interne `health-alert`-Job (Worker, alle 5 min) mailt bei Ausfall von
Postgres/Redis/Object-Store/ClamAV/Backup/App/n8n an `OPS_ALERT_EMAIL`. Er hat
aber zwei Systemgrenzen, die extern abgedeckt werden MÜSSEN:

1. **Plain-Docker restartet `unhealthy` Container nicht.** Die Restart-Policy
   `unless-stopped` greift nur bei Prozess-EXIT — ein Container, der läuft aber
   dessen HEALTHCHECK failt (Deadlock, Hänger), bleibt unbegrenzt stehen.
2. **Fällt der Worker selbst aus, kann er sich nicht alarmieren.**

Deshalb zusätzlich einrichten:

- **Auto-Restart bei `unhealthy`** — entweder ein autoheal-Sidecar
  (digest-gepinnt) mit `autoheal=true`-Label an app/worker/n8n, oder ein
  Host-systemd-Timer:

  ```bash
  # /usr/local/bin/taxtronik-autoheal.sh (systemd-Timer, z. B. alle 2 min)
  for c in $(docker ps --filter health=unhealthy --format '{{.Names}}'); do
    logger "autoheal: restarting $c"; docker restart "$c"
  done
  ```

- **Externer Uptime-Check** auf einer ZWEITEN Maschine / einem externen Dienst
  (Uptime-Kuma o. ä.) gegen `https://<host>/api/health` — erkennt einen
  Komplettausfall (auch wenn Worker + Mailversand tot sind).

Ohne diese beiden Bausteine kann ein Ausfall unbemerkt bleiben.
