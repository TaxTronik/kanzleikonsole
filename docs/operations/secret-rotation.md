# Secret-Rotation

Dieses Runbook beschreibt die Rotation produktiver Geheimnisse. Für
`AUTH_SECRET` gelten zusätzliche Abhängigkeiten; Details stehen in
[`../compliance/auth-secret-rotation.md`](../compliance/auth-secret-rotation.md).

## Grundregeln

- Vor jeder Rotation einen aktuellen, erfolgreich verifizierten
  `./taxtronik backup-full`-Stand erzeugen und bei konfiguriertem Offsite-Ziel
  dessen Receipt prüfen. Fehlt ein getrenntes Offsite-Ziel, ist das verbleibende
  Standortausfallrisiko im Betreiberprotokoll festzuhalten. Ein
  DB-only-`./taxtronik backup` ist nur eine zusätzliche Sicherung und reicht für
  S3-, n8n- oder Recovery-Schlüssel nicht aus.
- Nie mehrere unabhängige Secrets gleichzeitig rotieren, außer bei bestätigtem
  Leak.
- Alte Werte offline und verschlüsselt sichern, bis die Verifikation
  abgeschlossen ist und alle damit geschützten Backups ihre Aufbewahrungsfrist
  verlassen haben.
- Nach jeder Rotation: `./taxtronik doctor`, Health-Smoke, fachlicher Smoke.
- Jede Rotation im Betreiberprotokoll dokumentieren: Datum, Grund, betroffene
  Werte, zugehörige Backup-/Key-ID, Verifikation und Rollback-Plan.

## Secret-Matrix

| Secret                                                    | Zweck                             | Rotation                       | Auswirkung                             |
| --------------------------------------------------------- | --------------------------------- | ------------------------------ | -------------------------------------- |
| `AUTH_SECRET`                                             | Session-Signing, TOTP-Encryption  | nur nach Auth-Runbook          | Sessions ungültig, TOTP betroffen      |
| `SECRET_BOX_KEY`                                          | Tenant-/Integrations-Secrets      | nur mit Re-Wrap                | gespeicherte Secrets sonst unlesbar    |
| `POSTGRES_PASSWORD`                                       | DB-Owner/Migrationen              | Wartungsfenster                | App-Owner-Tools, Migrationen           |
| `TAXTRONIK_APP_PASSWORD`                                  | App-DB-Rolle mit RLS              | Wartungsfenster                | App/Worker DB-Zugriff                  |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY`                         | SeaweedFS S3                      | Wartungsfenster                | Uploads, Backups, Restore              |
| Outbound-HMAC je Tenant; `N8N_HMAC_SECRET` nur Legacy     | TaxTronik→n8n Event-Signaturen    | koordiniert App/Worker+n8n     | Event-Webhooks schlagen sonst fehl     |
| n8n Callback-Key/-Token                                   | n8n→TaxTronik Scoped Callback     | ohne Dual-Token-Fenster        | Callbacks schlagen sonst fehl          |
| n8n API-Key (Tenant-Einstellung)                          | Workflow-Verwaltung via `/api/v1` | überlappender Key-Wechsel      | Import/Status gestört, Webhooks laufen |
| `N8N_ENCRYPTION_KEY`                                      | n8n Credential-Store              | nur mit n8n-Backup             | n8n kann Credentials verlieren         |
| `N8N_DB_PASSWORD`                                         | n8n Postgres-Rolle                | Wartungsfenster                | n8n startet sonst nicht                |
| `SMTP_PASSWORD`                                           | SMTP-Relay                        | laufend möglich                | Mailversand                            |
| `RISK_LAYER_TOKEN`                                        | App↔Risk-Layer Bearer Auth        | koordiniert App+Engine         | Subsumtion/Risk-Layer inaktiv          |
| `BACKUP_OFFSITE_ACCESS_KEY` / `BACKUP_OFFSITE_SECRET_KEY` | getrenntes Offsite-S3             | mit überlappenden Zugangsdaten | Full-Backup-Upload und Receipt-Prüfung |
| Backup-Manifest Private Key                               | Ed25519-Signatur des Full-Backups | geplante Key-Zeremonie         | alte Public Keys für Altbackups nötig  |
| Update-Manifest Private Key                               | Release-Manifest-Signatur         | Vendor-Prozess                 | Update-Check fail-closed               |

## Standardablauf

1. Wartungsfenster ankündigen.
2. Backup:

```bash
./taxtronik doctor
./taxtronik backup-full
# Den in der Ausgabe genannten Stand mit getrennt verwahrtem Public Key prüfen:
./taxtronik backup-verify backups/full/<id> /offline/backup-manifest-public.pem
```

3. Neuen Wert erzeugen:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

4. Wert in `.env` setzen.
5. Betroffene Fremdkomponente anpassen, z. B. SMTP-Relay, n8n, Risk-Layer.
6. Stack gezielt neu starten:

```bash
./taxtronik deploy
```

7. Verifikation:

```bash
./taxtronik doctor
pnpm verify:chain
```

8. Fachlicher Smoke: Login, Upload, Mail/Test-Mail, n8n-Webhook, Backup-List.

## DB-Passwörter

DB-Passwörter betreffen nicht nur `.env`, sondern auch die Rollen in Postgres.
Reihenfolge:

1. Neues Passwort in Postgres setzen (`ALTER ROLE ... PASSWORD ...`).
2. `.env` aktualisieren.
3. `./taxtronik deploy`.
4. App-/Worker-Logs prüfen.

Bei externer Datenbank ist der Betreiber-DBA verantwortlich; TaxTronik darf
dann nur `.env` und Health prüfen.

## S3-Secrets

SeaweedFS liest seine S3-Konfiguration aus
den Umgebungsvariablen des Containers. Der Entrypoint rendert sie erst beim
Containerstart in das flüchtige tmpfs unter `/run/seaweedfs/s3.json` (Owner UID
1000, Modus `0400`). Eine hostseitige
`infra/scripts/seaweedfs-s3.generated.json` gibt es nicht mehr; historische
Kopien werden von Setup und Operator-CLI entfernt. Die `.env` wird auf dem Host
mit Modus `0600` geschützt.

Reihenfolge:

1. Full-Backup mit den alten Zugangsdaten verifizieren und offsite bestätigen.
2. `S3_ACCESS_KEY` und `S3_SECRET_KEY` gemeinsam in `.env` aktualisieren.
3. SeaweedFS und den Bucket-Init im Wartungsfenster mit den neuen Werten neu
   erzeugen:

   ```bash
   ./taxtronik --infra up -d --force-recreate seaweedfs seaweedfs-init
   ```

4. `./taxtronik deploy` ausführen, damit App und Worker dieselben Credentials
   verwenden.
5. Upload, Download, `./taxtronik backup` und anschließend einen neuen
   `backup-full`-Lauf testen. Die historische generated-Datei darf danach nicht
   existieren.

## n8n-Secrets

### HMAC-Secret

Das verschlüsselt in der Tenant-Connection gespeicherte HMAC-Secret schützt den
Outbound-Pfad: App/Worker signieren Events an n8n, die dortige HMAC-Prüfung
verifiziert sie. `N8N_HMAC_SECRET` ist nur der globale Fallback für
Installationen ohne normalisierte Connection. Das scoped Callback-Credential
in Gegenrichtung ist davon unabhängig. Globale
Legacy-Callbacks unter `/api/n8n/*` sind default-off; nur wenn
`N8N_LEGACY_CALLBACKS_ENABLED=true` gesetzt ist, verwenden sie das globale
HMAC-Secret bis zu ihrer Migration. Unabhängig davon nutzt auch ein gesetztes
`N8N_WEBHOOK_BASE_URL` dasselbe Secret für ausgehende Legacy-Events. In
Produktion erzwingt TaxTronik für beide Opt-ins mindestens 32 Zeichen; bleiben
beide deaktiviert, wird das globale Secret nicht benötigt.

Es gibt kein automatisches Alt-/Neu-Secret-Fenster. Die Rotation erfolgt daher
koordiniert:

1. Aktuellen n8n-Zustand, offene `PENDING`-/`FAILED`-Zustellungen
   und letzte erfolgreiche Outbound-Zustellungen dokumentieren. Full-Backup nach
   Standardablauf erstellen und verifizieren.
2. Event-Webhook-Workflows und gegebenenfalls noch vorhandene Legacy-
   HMAC-Callback-Workflows pausieren. Den TaxTronik-Worker stoppen, damit
   Outbox-Einträge nicht mit gemischten Secrets zugestellt werden.
   TaxTronik-Kernfunktionen dürfen weiterlaufen; die Outbox sammelt neue Events.
3. Neuen Wert in den zugeordneten n8n-Crypto-Credentials aller
   Event-Webhook-Workflows hinterlegen. Secret niemals in Workflow-JSON,
   Variables, Node-Notizen oder Logs schreiben.
4. Denselben Wert in der Tenant-Konfiguration unter
   **Administration → Einstellungen → n8n-Automatisierung** setzen. Nutzt die
   Installation noch den ENV-Fallback, zusätzlich `N8N_HMAC_SECRET`
   in `.env` ändern und App/Worker mit `./taxtronik deploy`
   neu starten.
5. Systemuhren prüfen, Workflows wieder veröffentlichen/aktivieren und den
   Worker starten. Zuerst `taxtronik.ping` gegen dessen
   Production-Ziel prüfen; fachliche Event-Ziele ausschließlich über die
   getrennte Test-URL mit synthetischem Payload testen. Legacy-Callbacks,
   solange vorhanden und ausdrücklich aktiviert, getrennt synthetisch prüfen.
6. Outbox beobachten: keine neuen HMAC-Fehler, Rückstau wird abgearbeitet,
   Fan-out-Ziele enden in `DELIVERED`. Erst danach den alten Wert aus
   der verschlüsselten Rollback-Verwahrung entfernen.

Kann Schritt 4 nicht im selben Wartungsfenster erfolgen, bleiben Workflows und
Worker pausiert. Nicht abwechselnd alte und neue Secrets testen: Retries würden
sonst uneindeutige Zustände erzeugen.

### Scoped Callback-Key und -Token

Neue n8n → TaxTronik-Aufrufe verwenden
`/api/integrations/n8n/v1/*` mit
`x-taxtronik-key-id`, Bearer-Token, einem minimalen Scope und einer
einmaligen `x-taxtronik-request-id`. Das Token wird nur bei der
Erzeugung angezeigt und nur gehasht gespeichert. Eine Neuerzeugung macht das
alte Token sofort ungültig; parallele Alt-/Neu-Tokens werden nicht akzeptiert.

1. Betroffene Callback-Workflows pausieren und ihre benötigten Scopes
   dokumentieren: `requests:read`, `gwg:read`,
   `research:write` und/oder `inbound-mail:write`.
2. Unter **Administration → Einstellungen → n8n-Automatisierung** einen neuen
   Callback-Zugang mit genau diesen Scopes erzeugen. Das nur einmal angezeigte
   Token sofort als `Authorization: Bearer <token>` in das Generic-
   Header-Credential **TaxTronik Callback** übernehmen. Materialisierte
   App-Basis und Key-ID in den Nodes mit dem Assistentenwert abgleichen; bei
   einer neuen Connection die verwalteten Workflows erneut kontrolliert
   importieren. Secrets niemals in Platzhalter oder Workflow-JSON schreiben.
3. Für jeden freigegebenen Scope einen synthetischen Aufruf mit neuer
   `x-taxtronik-request-id` testen. Erwartung: fachlich zulässige
   Antwort; ein zweiter Read mit derselben ID ergibt `409`, ein Retry eines
   erfolgreich abgeschlossenen Writes `200` mit `duplicate: true`.
   `503` bedeutet, dass der Redis-Replay-Speicher nicht verfügbar ist
   und muss vor Wiederaufnahme behoben werden.
4. Workflows wieder aktivieren, Callback-Fehler beobachten und den alten Wert
   aus der n8n-Credential-Historie sowie temporären Notizen entfernen.

Keinen HMAC-Wert oder n8n-Management-API-Key als Callback-Token
wiederverwenden. Die alten HMAC-Callbacks unter `/api/n8n/*` sind ein
default-off geschalteter Migrationspfad und erhalten keine Callback-Scopes.

### n8n-Management-API-Key

Der API-Key ist vom HMAC-Secret unabhängig. Ein API-Ausfall verhindert Import
und Statusabfrage, aber nicht die Zustellung an bereits gespeicherte
Production-Webhooks. Rotation möglichst ohne Unterbrechung:

1. In n8n einen neuen, ablaufenden Key anlegen. Wenn unterstützt, nur
   `workflow:list`, `workflow:read` und
   `workflow:create` erlauben. TaxTronik veröffentlicht Vorlagen
   nicht selbst; `workflow:update` und `workflow:activate`
   sind nicht erforderlich.
2. Neuen Key in TaxTronik speichern und Workflow-Liste sowie einen
   synthetischen Test abrufen. Webhook-HMAC separat kontrollieren.
3. Alten Key in n8n widerrufen und den Wechsel protokollieren.

n8n-Editionen ohne Scoped API Keys behandeln den Schlüssel wie einen
weitreichenden Admin-Zugang: dedizierten Service-Account/Projekt nutzen und
kurze Laufzeit wählen. Offizielle Hinweise:
[n8n API authentication](https://docs.n8n.io/api/authentication/).

### n8n-Credential-Verschlüsselung

`N8N_ENCRYPTION_KEY` ist kritischer: n8n verschlüsselt gespeicherte Credentials
damit und hält den wirksamen Wert zusätzlich im persistenten `n8n_data`-Volume.
Ein bloßes Ändern der `.env` rotiert den Schlüssel daher **nicht**: Die
Operator-CLI erkennt die Abweichung und stellt zum Schutz bestehender
Credentials den Volume-Schlüssel in `.env` wieder her.

Eine Rotation ist nur als geplante n8n-Migration zulässig:

1. verifiziertes, offsite vorhandenes `backup-full` erstellen; es enthält
   n8n-Datenbank, `n8n_data`-Cold-Snapshot und die dazu passende
   Recovery-Konfiguration,
2. Workflows exportieren und alle Credentials dokumentiert neu einspielbar
   machen,
3. das von der eingesetzten n8n-Version unterstützte Migrations-/Importverfahren
   zuerst auf einem isolierten Restore-System proben,
4. erst dann produktiv migrieren und jeden credential-abhängigen Workflow
   testen.

TaxTronik automatisiert keine In-place-Neuverschlüsselung vorhandener
n8n-Credentials. Ohne dieses Verfahren nicht rotieren.

## Backup- und Offsite-Schlüssel

`BACKUP_AGE_RECIPIENT` ist öffentlich; die dazugehörige age-Identity gehört
nicht auf den Produktivhost, sondern getrennt beziehungsweise offline in die
Recovery-Verwahrung. Bei einem Empfängerwechsel müssen alte age-Identities bis
zum Ablauf des letzten damit verschlüsselten Backups erhalten bleiben.

Analog gilt für den Ed25519-Manifest-Schlüssel: Nach einer Rotation wird für
neue Backups der neue Private Key verwendet, während der alte Public Key zur
Prüfung vorhandener Backups erhalten bleibt. Für jedes Full-Backup muss
nachvollziehbar sein, mit welcher age-Identity es entschlüsselt und mit welchem
Public Key es geprüft wird. Nach jeder Key-Rotation sofort ein neues
`backup-full` erzeugen, mit den neuen Schlüsseln verifizieren und offsite
bestätigen.

Offsite-Zugangsdaten möglichst überlappend rotieren: neuen Zugang anlegen,
`./taxtronik backup-offsite <full-backup-verzeichnis>` samt Object-Lock- und
Receipt-Prüfung erfolgreich durchführen und erst danach den alten Zugang
widerrufen. Ein erfolgreicher Upload ersetzt keinen isolierten Full-Restore-
Drill.

## Risk-Layer-Token

1. Neuen Token in der Risk-Layer-Engine hinterlegen.
2. `RISK_LAYER_TOKEN` in TaxTronik setzen.
3. `./taxtronik deploy`.
4. Subsumtions-Analyse mit Testfall ausführen.

## AUTH_SECRET

`AUTH_SECRET` ist kein normales Rotationsthema. Es schützt Sessions und
TOTP-Seeds. Secret-box-Werte nutzen bei Neuinstallationen den getrennten
`SECRET_BOX_KEY`; Legacy-Installationen ohne diesen Wert fallen weiterhin auf
`AUTH_SECRET` zurück. Das Verfahren steht in
[`../compliance/auth-secret-rotation.md`](../compliance/auth-secret-rotation.md)
und verlangt ein eigenes Wartungsfenster.

`SECRET_BOX_KEY` nie durch bloßes Ändern der `.env` rotieren. Alle damit
verschlüsselten Werte müssen in einem Wartungsfenster mit dem alten Schlüssel
entschlüsselt und atomisch mit dem neuen rewrapped werden. Fehlt der Wert in
einer bestehenden Installation, gilt das erstmalige Setzen ebenfalls als
Rotation vom Legacy-Fallback (`AUTH_SECRET`) auf den neuen Schlüssel.

## Rollback

Rollback ist nur zulässig, solange der alte Wert gesichert ist und keine
Komponente bereits irreversible Daten mit dem neuen Wert erzeugt hat. Bei
`AUTH_SECRET`, `N8N_ENCRYPTION_KEY`, age-Identities und Backup-Signaturschlüsseln
ist Rollback besonders vorsichtig zu bewerten; bestehende Backups dürfen durch
die Schlüsselrücknahme nicht unprüfbar oder unentschlüsselbar werden.
