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
4. n8n-Ziele prüfen: Workflows veröffentlicht, letzter synthetischer Test
   erfolgreich, keine unerklärten `FAILED`, `PARTIAL` oder `UNROUTED`-Events;
   API-Key-Ablauf und Credential-Berechtigungen kontrollieren.
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

Existiert nach einem abgebrochenen Deploy oder Produktionsrestore
`.taxtronik.migration-pending` beziehungsweise `.taxtronik.database-restored`,
verweigert `backup-full` den anfänglichen n8n-Start und damit den gesamten Lauf.
Das ist ein Sicherheits-Gate, kein zu löschender Lock: zuerst den dokumentierten
Deploy-/Restore-/Rollback-Pfad abschließen. Dasselbe gilt für manuelle
`./taxtronik up`-/`restart`-Aufrufe; direktes `docker compose` darf nicht als
Umgehung verwendet werden.

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

Jeder mutierende Restore verlangt ein explizites Ziel; einen stillen Fallback
auf die produktive `DATABASE_URL` gibt es nicht. Der In-place-Produktionspfad
ist ausschließlich für den kontrollierten DR-Fall vorgesehen und im
Disaster-Recovery-Runbook beschrieben.

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

Die Deploy-Readiness prüft dabei nicht nur Storage und Virenscanner, sondern
auch den zum Checkout gehörenden GwG-Datenbankschutz. Ab Migration `04300` /
`04400` müssen insbesondere die stabile Vertretertabelle, Subject- und
Dokumentsatz-Spalten, das exakte Identity-Gate sowie alle zugehörigen
Verification- und Invalidierungs-Trigger tatsächlich in PostgreSQL vorhanden
und aktiv sein. `04400` weist außerdem die Sperre jeder Version-Mutation eines
bereits zugeordneten GwG-Belegs nach. Ein lediglich per
`prisma migrate resolve --applied` geschlossenes Journal reicht weder für
Readiness noch für die Recovery eines Pending-Vertrags aus. Der Nachweis
läuft unmittelbar nach `migrate deploy` vor der Aktivierung neuer Writer und
nochmals in der Deploy-Readiness; bei Abweichungen bleibt die Aktivierung
fail-closed.

### Recovery des GwG-Migrationsfehlers `03400` (P3018/42883)

Eine vor dem ersten Release kurzzeitig auf `main` vorhandene Fassung von
`20260801003400_gwg_fail_closed_and_destruction` konnte beim Upgrade eines
verifizierten Rechtsträger-Altbestands vor Anlage der kontrollierten
Vernichtungsfunktion abbrechen. Prisma/PostgreSQL rollen diese Migration als
Ganzes zurück; das offene Prisma-Journal und der lokale Migrationsvertrag
blockieren danach dennoch weitere Migrationen. Operator-Guard und produktiver
Migrate-Container erkennen ausschließlich diese exakte Signatur (`42883`,
fehlende Funktion, `applied_steps_count = 0` und keine der neuen Spalten),
führen den Pending-Vertrag nur auf einen neueren Fix-Commit fort und markieren
den DB-Eintrag vor dem korrigierten Neuversuch automatisch als `rolled-back`.
Andere Migrationsfehler bleiben unverändert fail-closed.

Legacy-Lokalinstallationen können im Last-Good-State noch keinen Quell-Commit
enthalten. Ein solcher Pending-Vertrag darf nur mit bereits gesetzter
DB-Restore-Pflicht, nachgewiesener Ziel-Commit-Ancestry und der exakten
GwG-Fehlersignatur fortgesetzt werden. Wurde Prisma kontrolliert manuell
aufgelöst, ist stattdessen ein vollständig geschlossenes Prisma-Journal nötig,
in dem jede Migration des bisherigen Pending-Zielcommits erfolgreich
abgeschlossen ist. Zusätzliche Migrationen eines nachweislichen
Vorwärts-Commits dürfen danach unter derselben, niemals abgeschwächten
DB-Restore-Pflicht angewendet werden.

Die Operator-CLI lädt ihre Funktionen beim Prozessstart. Stammt der aktuell
laufende Update-Prozess noch aus dem fehlerhaften Checkout, kann er den gerade
erst geholten Recovery-Code nicht nachladen. In diesem einmaligen Übergang
`./taxtronik update` daher zweimal als getrennte Prozesse ausführen: Der erste
Lauf erstellt das Pflichtbackup, holt den für den jeweiligen Betriebsmodus
verifizierten Checkout und kann danach noch am alten Pending-Guard stoppen. Der
zweite Lauf lädt den neuen Recovery-Code und übernimmt Marker- und DB-Recovery
automatisch. Den Pending-Marker nicht löschen oder von Hand editieren. Dieses
Zwei-Lauf-Verfahren gilt auch für Registry-/Tag-Deployments; kein manuelles
`git pull` anstelle der signierten Release-Auswahl verwenden.

Wer Prisma außerhalb des Operator-Deployments ausführt, verwendet nach Backup
und gestoppten Writern:

```bash
pnpm --filter @taxtronik/db exec prisma migrate resolve \
  --rolled-back 20260801003400_gwg_fail_closed_and_destruction
pnpm --filter @taxtronik/db exec prisma migrate deploy
pnpm --filter @taxtronik/db exec prisma migrate status
```

Für diesen Fall weder `--applied` noch `migrate reset` verwenden. Prisma
dokumentiert den Ablauf unter
[Failed migrations](https://www.prisma.io/docs/orm/prisma-migrate/workflows/patching-and-hotfixing#failed-migration).

Die Operator-CLI setzt für neu erzeugte Dateien `umask 077` und härtet `.env`
auf Modus `0600`. Ausschließlich Git-Operationen, die den getrackten
Release-Checkout aktualisieren (Fast-Forward oder Rollback), laufen mit
`umask 022`; die Image-Builder normalisieren die Quellmodi zusätzlich vor jedem
Runtime-Copy. So bleiben Secrets restriktiv, während der non-root-User `node`
Migrationen und Anwendungscode sicher lesen kann. Eine hostseitige
`seaweedfs-s3.generated.json` gibt es nicht mehr: SeaweedFS rendert die
Konfiguration beim Containerstart flüchtig unter `/run` als UID 1000 mit Modus
`0400`. Historische generierte Dateien werden entfernt. Die CLI muss unter dem
Dateieigentümer des Deployment-Checkouts ausgeführt werden.

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

n8n ist im Stack enthalten; sobald die Kanzlei die Integration aktiviert,
gehört es zum überwachten Produktionsbetrieb. Im bewusst deaktivierten Modus
bleiben die TaxTronik-Kernfunktionen unabhängig. Mailhog ist dagegen nie ein
Produktionsdienst. Die Integration besitzt zwei getrennte Ebenen:

1. **Instanzverwaltung:** UI-URL und optional API-URL/API-Key zum Auflisten,
   Prüfen und selektiven Importieren von Workflows. TaxTronik veröffentlicht
   oder überschreibt bestehende Workflows nicht.
2. **Event-Routing:** exakte Production-Webhook-URL je Workflow und die dazu
   aktivierten Event-Abonnements. Ein Event kann an mehrere Ziele gehen.

Instanz-UI (`https://n8n.example`), API-URL
(`http://n8n:5678/api/v1`), Webhook-Präfix
(`http://n8n:5678/webhook`) und exakte Production-URL
(`http://n8n:5678/webhook/<workflow-route>`) nicht verwechseln.
`N8N_WEBHOOK_BASE_URL` ist nur noch der Legacy-Pfad
`<Präfix>/<event>`; neue Installationen und eigene Workflows nutzen
workflow-spezifische Ziele im Routing-Modus `EXPLICIT`. Production-Compose
lässt den ENV-Fallback standardmäßig leer. Sobald er für eine Migration gesetzt
ist, verlangt TaxTronik auch bei deaktivierten Legacy-Callbacks ein mindestens
32 Zeichen langes `N8N_HMAC_SECRET` für die Outbound-Signaturen.

Globale eingehende Legacy-Callbacks `/api/n8n/*` sind unabhängig davon
default-off und liefern `404`. Eine befristete Migration erfordert exakt
`N8N_LEGACY_CALLBACKS_ENABLED=true` sowie in Produktion ein mindestens
32 Zeichen langes `N8N_HMAC_SECRET`. Aktivierung, betroffene Workflows und
Abschaltdatum im Betriebsjournal festhalten; nach der Migration wieder
`false` setzen und App/Worker neu starten.

Neue Routen und Routen mit geänderter Production-URL, Test-URL oder
Eventauswahl werden immer als deaktivierter Entwurf gespeichert. Der Test ist
für tenantgebundene Entwürfe erlaubt. Erst nach einem erfolgreichen
synthetischen Test kann der Betreiber die unveränderte Route in einem zweiten
Speichervorgang aktivieren; jede weitere relevante Änderung setzt
Prüfnachweis und Aktivierung zurück.

### Tägliche und monatliche Kontrolle

- `./taxtronik doctor` sowie App-/Worker-/n8n-Logs prüfen.
- Unter **Administration → Einstellungen → n8n-Automatisierung** den Zustand jedes
  Ziels prüfen. `PARTIAL` heißt: mindestens ein Fan-out-Ziel fehlgeschlagen;
  `UNROUTED`: für ein ausdrücklich konfiguriertes Event existiert derzeit kein
  aktives Abonnement. Nie abonnierte Events enden dagegen ohne Alarm als
  `SKIPPED`. Nach Korrektur
  der Route nur fachlich freigegebene offene Events über **Jetzt zuordnen**
  nach Bestätigung von Alter und Datenschutzrisiko nachholen; es gibt kein
  automatisches Replay auf ein später angelegtes Ziel. Nicht mehr gewünschte
  Events mit **Nicht senden** auditiert als `SKIPPED` abschließen.
- Wiederholte `FAILED`-Zustellungen anhand ihrer stabilen `deliveryId`
  untersuchen. Nicht durch manuelle Workflow-Ausführung „beheben", bevor die
  Idempotenz geklärt ist. Die UI zeigt offene Fehler unabhängig von neueren
  Erfolgen zuerst und lädt sie seitenweise nach. Einen Retry nur bei weiterhin
  identischer Route, URL und Secret-Zuordnung auslösen. Veraltete oder fachlich
  verworfene Altfehler bewusst mit **Quittieren** ohne HTTP-Versand als
  `SKIPPED` abschließen; TaxTronik protokolliert die Admin-Entscheidung in der
  Evidence-Chain.
- Monatlich jedes aktive Ziel mit dem synthetischen Event-Beispiel über seine
  separate Test-URL prüfen und anschließend die n8n-Execution kontrollieren.
  Nur `taxtronik.ping` darf zusätzlich gegen eine veröffentlichte
  Production-URL laufen; fachliche Events niemals. Keine Echtdaten als
  Testinput.
- Der tägliche Job `n8n-retention` läuft um 03:45 UTC. Er löscht terminale
  Outbox-Payloads samt Zustellhistorie nach 90 Tagen (`DELIVERED`, `SKIPPED`,
  `UNROUTED`) bzw. 180 Tagen (`FAILED`, `PARTIAL`). `PENDING` und `PROCESSING`
  werden nie gelöscht. Gehashte Callback-Idempotenzbelege werden nach 180
  Tagen gelöscht. Lauf und alle Löschzähler im Worker-Log überwachen.
- Prüfen, ob Workflows nach Änderungen tatsächlich **veröffentlicht** wurden.
  Gespeicherte Entwürfe ändern die Production-Ausführung nicht.
- Ablauf und Scopes des n8n-API-Keys kontrollieren. Wenn die Edition keine
  Scoped Keys unterstützt, den weitreichenden Schlüssel in einem dedizierten
  Service-Account/Projekt führen und kurz befristen.
- n8n-Ausführungsdaten und Fehler-Payloads gemäß Löschkonzept bereinigen;
  Zugriff auf die n8n-UI und Credentials regelmäßig rezertifizieren.
- Das Production-Compose setzt `N8N_DIAGNOSTICS_ENABLED=false` und deaktiviert
  außerdem den externen Template-Katalog sowie n8n-Versionsabrufe. Updates
  werden über den im TaxTronik-Release gepinnten Image-Digest eingespielt. Eine
  abweichende Freigabe externer Abrufe ist als Datenfluss zu dokumentieren;
  Telemetrie bleibt wegen § 203 StGB und Datenminimierung deaktiviert. Referenz:
  [n8n Deployment-Umgebungsvariablen](https://docs.n8n.io/hosting/configuration/environment-variables/deployment/).

Die Zustellung ist at least once. `eventId` bleibt über Fan-out und Retries
stabil; `deliveryId` bleibt für ein einzelnes Ziel über Retries stabil. Jeder
Ein fachlicher Workflow muss Seiteneffekte dauerhaft und fehlertolerant nach
`deliveryId` idempotent machen. Ein begrenzter n8n-**Remove Duplicates**-Knoten
genügt nicht: Er kann volllaufen und vor einem fehlgeschlagenen Seiteneffekt
bereits den Schlüssel verbrauchen. Die Nonce im HMAC-Header ist nur
Replay-Schutz eines HTTP-Versuchs und kein fachlicher Idempotenzschlüssel.

### Verbindungs- und Credential-Prüfung

- Das pro Tenant verschlüsselt gespeicherte HMAC-Secret ist im
  n8n-Crypto-Credential der eingehenden TaxTronik-Events identisch. Das globale
  `N8N_HMAC_SECRET` wird nur noch für ausdrücklich aktivierte Legacy-Callbacks
  oder den ausdrücklich gesetzten Outbound-Fallback
  `N8N_WEBHOOK_BASE_URL` benötigt. Sobald einer der Pfade aktiv ist, erzwingt
  die Produktionskonfiguration mindestens 32 Zeichen.
- `N8N_ENCRYPTION_KEY` passt zum bestehenden n8n-Volume.
- Der TaxTronik-Import materialisiert die erreichbare App-Basis und
  tenantgebundene Callback-Key-ID als nicht geheime Node-Konfiguration. Nach
  URL-, Domain- oder Tenant-Wechsel die verwalteten Workflows kontrolliert
  aktualisieren; neue Workflows rufen ausschließlich
  `/api/integrations/n8n/v1/*` auf und haben keinen Datenbankzugriff.
- Die App-Basis kommt aus dem separat gespeicherten Feld
  **TaxTronik-Adresse aus n8n**. Für `BUNDLED` ist der Standard
  in Produktion `http://app:3000`, im lokalen Dev-Stack
  `http://host.docker.internal:3000`; für `SELF_HOSTED`/`CLOUD` muss die URL
  aus der n8n-Laufzeit erreichbar sein. Sie ist nicht automatisch mit der
  Browser-/`NEXTAUTH_URL` identisch.
- In veröffentlichten Workflows dürfen keine
  `__TAXTRONIK_API_URL__`-,
  `__TAXTRONIK_CALLBACK_KEY_ID__`-, `__SMTP_FROM__`- oder
  `__GWG_OFFICER_EMAIL__`-Platzhalter übrig sein. Bei manuellem
  Dateiimport die Nicht-Geheimnisse direkt in den betroffenen Nodefeldern
  pflegen.
- Das Credential **TaxTronik Callback** ist Generic Header Auth und enthält
  ausschließlich `Authorization: Bearer <token>`. Nur tatsächlich
  benötigte Scopes
  (`requests:read`, `gwg:read`,
  `research:write`, `inbound-mail:write`) freigeben.
  Jeder fachliche Aufruf braucht eine eindeutige
  `x-taxtronik-request-id`, die über seine HTTP-Retries stabil bleibt.
- Der mitgelieferte Container blockiert `$env`-Zugriff aus Nodes.
  Die materialisierten Nicht-Geheimnisse liegen in den konkreten Nodes;
  Secrets gehören nur in Credentials. Dadurch benötigen die Workflows keine
  editionsabhängigen Custom Variables und laufen mit n8n Community.
- Die API-URL endet auf `/api/v1`; die Event-Ziele dagegen auf einer konkreten
  `/webhook/<route>`. Ein Ausfall der Management-API bedeutet nicht zwingend,
  dass gespeicherte Webhook-Ziele ausfallen.
- Außerhalb des isolierten Compose-Netzes TLS erzwingen. Outbound-HMAC und
  Callback-Token authentisieren, verschlüsseln aber keine
  §-203-/Personendaten.

Bei Auth-Fehlern Secrets nicht blind neu generieren. Erst Richtung und
Credential unterscheiden: TaxTronik → n8n verwendet HMAC mit
Timestamp/Nonce; n8n → TaxTronik verwendet Key-ID, Bearer-Token, Scope und
eindeutige Request-ID. Beim Outbound-Pfad
`x-taxtronik-event`, `x-taxtronik-delivery-id`, Nonce und
Body prüfen. Beim Callback bedeuten `401` ungültige Zugangsdaten,
`403` fehlenden Scope, `409` einen noch laufenden parallelen Aufruf
(oder einen wiederholten Read) und `503` einen nicht verfügbaren
Replay-Speicher. Ein Retry eines bereits erfolgreich abgeschlossenen
`research-result`- oder `request-inbound`-Writes antwortet idempotent mit
`200` und `duplicate: true`.
Rotation erfolgt ausschließlich nach
[`secret-rotation.md`](secret-rotation.md#n8n-secrets).

### Fehlerbilder

| Signal                               | Ursache/Prüfung                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `404`                                | Test-URL oder falsche Route gespeichert; Workflow nicht veröffentlicht               |
| `401`/`403`                          | Outbound-HMAC, Callback-Key/-Token/-Scope oder Management-API-Key falsch             |
| Callback `409`                       | Gleiche Request-ID läuft noch oder wiederholter Read; `Retry-After` beachten         |
| Callback `503`                       | Redis-/Replay-Speicher nicht verfügbar; Callback schlägt fail-closed fehl            |
| API rot, Webhooks grün               | Management-URL/-Key gestört; Zustellpfad separat bewerten                            |
| alle Ziele rot                       | n8n/Netz/TLS/Outbound-HMAC prüfen                                                    |
| genau ein Ziel rot                   | exakte URL, Veröffentlichung und letzte Execution dieses Workflows prüfen            |
| `200`, aber fachlich ohne Wirkung    | Nachgelagerte Nodes/Callback-Credentials prüfen; Transportstatus ist kein Fachstatus |
| Duplikate                            | Dauerhafte, transaktionale Idempotenz nach stabiler `deliveryId` fehlt               |
| Route bleibt deaktiviert             | Entwurf noch nicht erfolgreich getestet oder beim Aktivieren inhaltlich geändert     |
| Container erreicht `localhost` nicht | Compose-Service-DNS (`n8n`, `app`) statt Loopback verwenden                          |

Bei Reverse Proxy `WEBHOOK_URL`, `N8N_PROXY_HOPS` und Forwarded-Header passend
setzen; offizielle Anleitung:
[n8n hinter einem Reverse Proxy](https://docs.n8n.io/hosting/configuration/configuration-examples/webhook-url/).
Test- und Production-URLs sowie Publish-Semantik beschreibt die
[Webhook-Dokumentation](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/).

Die fachliche Einrichtung und der vollständige Eventkatalog stehen in
[n8n-Automatisierungen](../anwenderdoku/n8n-automatisierungen.md).

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
