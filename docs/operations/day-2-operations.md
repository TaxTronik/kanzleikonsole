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

Dann:

```bash
./taxtronik update
```

Das Update zieht Code per `git merge --ff-only`, legt vor Migrationen ein
Backup an, baut oder zieht Images, migriert und startet neu. Kein
`git reset --hard`: Lokale Abweichungen müssen bewusst aufgelöst werden.

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

| Signal | Sofortmaßnahme | Danach |
|---|---|---|
| Audit-Chain-Bruch | Schreibzugriffe stoppen, Backup sichern | `verify:chain` Report sichern, Ursache isolieren |
| Restore fehlgeschlagen | Keine weiteren Migrationen | letztes intaktes Backup suchen, `disaster-recovery.md` |
| SMTP down | Betreiber informieren, Relay prüfen | Test-Mail, Worker-Logs |
| n8n HMAC invalid | Webhooks pausieren | Secret-/Volume-Abgleich |
| Speicher fast voll | Builds stoppen, `docker system df` | Build-Cache prune, Log-Rotation prüfen |
| Verdacht auf Secret-Leak | Sessions invalidieren | [`secret-rotation.md`](secret-rotation.md) |

## Nachweise ablegen

Für prüfungsnahe Betreiber sollten diese Artefakte revisionssicher abgelegt
werden:

- CI-Testberichte (`testbericht-unit`, `testbericht-ops`, `testbericht-db`,
  `testbericht-restore`, Playwright-Reports)
- Security-Workflow-Artefakte
- Restore-Drill-Protokolle
- Release-Tag, Commit-SHA, Image-Digests
- Changelog-Abschnitt des ausgelieferten Tags
