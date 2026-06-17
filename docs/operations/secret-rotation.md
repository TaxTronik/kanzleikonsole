# Secret-Rotation

Dieses Runbook beschreibt die Rotation produktiver Geheimnisse. Für
`AUTH_SECRET` gelten zusätzliche Abhängigkeiten; Details stehen in
[`../compliance/auth-secret-rotation.md`](../compliance/auth-secret-rotation.md).

## Grundregeln

- Vor jeder Rotation: `./taxtronik backup`.
- Nie mehrere unabhängige Secrets gleichzeitig rotieren, außer bei bestätigtem
  Leak.
- Alte Werte offline und verschlüsselt sichern, bis die Verifikation
  abgeschlossen ist.
- Nach jeder Rotation: `./taxtronik doctor`, Health-Smoke, fachlicher Smoke.
- Jede Rotation im Betreiberprotokoll dokumentieren: Datum, Grund, betroffene
  Werte, Verifikation, Rollback-Plan.

## Secret-Matrix

| Secret | Zweck | Rotation | Auswirkung |
|---|---|---|---|
| `AUTH_SECRET` | Session-Signing, secret-box, TOTP-Encryption | nur nach Auth-Runbook | Sessions ungültig, Tenant-Secrets/TOTP betroffen |
| `POSTGRES_PASSWORD` | DB-Owner/Migrationen | Wartungsfenster | App-Owner-Tools, Migrationen |
| `TAXTRONIK_APP_PASSWORD` | App-DB-Rolle mit RLS | Wartungsfenster | App/Worker DB-Zugriff |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | SeaweedFS S3 | Wartungsfenster | Uploads, Backups, Restore |
| `N8N_HMAC_SECRET` | App↔n8n Webhook-Signaturen | koordiniert App+n8n | Webhooks schlagen sonst fehl |
| `N8N_ENCRYPTION_KEY` | n8n Credential-Store | nur mit n8n-Backup | n8n kann Credentials verlieren |
| `N8N_DB_PASSWORD` | n8n Postgres-Rolle | Wartungsfenster | n8n startet sonst nicht |
| `SMTP_PASSWORD` | SMTP-Relay | laufend möglich | Mailversand |
| `RISK_LAYER_TOKEN` | App↔Risk-Layer Bearer Auth | koordiniert App+Engine | Subsumtion/Risk-Layer inaktiv |
| Update-Manifest Private Key | Release-Manifest-Signatur | Vendor-Prozess | Update-Check fail-closed |

## Standardablauf

1. Wartungsfenster ankündigen.
2. Backup:

```bash
./taxtronik doctor
./taxtronik backup
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
`infra/scripts/seaweedfs-s3.generated.json`, das vor Compose-Aufrufen aus
`.env` gerendert wird.

Reihenfolge:

1. `.env` aktualisieren.
2. `./taxtronik --infra up -d seaweedfs`.
3. `./taxtronik deploy`.
4. Upload, Download und `./taxtronik backup` testen.

## n8n-Secrets

`N8N_HMAC_SECRET` kann koordiniert rotiert werden: App/Worker und n8n müssen
denselben Wert sehen.

`N8N_ENCRYPTION_KEY` ist kritischer: n8n verschlüsselt gespeicherte Credentials
damit. Vor Rotation:

1. n8n-Workflow-Export sichern.
2. Credentials dokumentiert neu einspielbar machen.
3. n8n-Volume sichern.

Ohne diese Vorbereitung nicht rotieren.

## Risk-Layer-Token

1. Neuen Token in der Risk-Layer-Engine hinterlegen.
2. `RISK_LAYER_TOKEN` in TaxTronik setzen.
3. `./taxtronik deploy`.
4. Subsumtions-Analyse mit Testfall ausführen.

## AUTH_SECRET

`AUTH_SECRET` ist kein normales Rotationsthema. Es schützt Sessions, TOTP-Seeds
und secret-box-Werte. Das Verfahren steht in
[`../compliance/auth-secret-rotation.md`](../compliance/auth-secret-rotation.md)
und verlangt ein eigenes Wartungsfenster.

## Rollback

Rollback ist nur zulässig, solange der alte Wert gesichert ist und keine
Komponente bereits irreversible Daten mit dem neuen Wert erzeugt hat. Bei
`AUTH_SECRET` und `N8N_ENCRYPTION_KEY` ist Rollback besonders vorsichtig zu
bewerten.
