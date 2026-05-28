# n8n-Workflows für taxtronik

Diese JSON-Dateien sind **Beispiel-Workflows** für die Kommunikations- und
Reminder-Automatisierung. Jede Kanzlei kann sie nach eigenen Bedürfnissen
anpassen.

## Setup

1. n8n starten (siehe `docker-compose.yml`).
2. n8n-Web-UI öffnen: <http://localhost:5678>
3. Workflows importieren: **Workflows → Import from File** → die JSONs hier
   nacheinander auswählen.
4. Credentials anlegen:
   - **Taxtronik HMAC Auth** (Generic Header Auth):
     - Header-Name: `x-taxtronik-signature`
     - Header-Wert: `<wird via Pre-Request-Script aus N8N_HMAC_SECRET berechnet>`
   - **Kanzlei SMTP** (E-Mail SMTP) mit den eigenen SMTP-Daten.
5. Environment-Variablen in n8n setzen:
   - `TAXTRONIK_API_URL` (z. B. `http://app:3000` im Docker-Netz)
   - `N8N_HMAC_SECRET` (identisch mit `N8N_HMAC_SECRET` in der App)
   - `SMTP_FROM`
   - `GWG_OFFICER_EMAIL`
6. Workflows aktivieren.

## Workflows

| Datei | Trigger | Zweck |
|---|---|---|
| `01-request-reminder.json` | Cron Mo–Fr 09:00 | Erinnerungs-Mail an Mandanten für überfällige Anforderungen |
| `02-gwg-expiry-check.json` | Cron täglich 08:00 | Warn-Mail an GwG-Beauftragten für GwG-Prüfungen, die in <30 Tagen ablaufen |
| `03-request-opened.json` | Webhook `request.opened` | Sendet Benachrichtigungs-Mail an Mandanten, wenn die App eine neue Anforderung anlegt |

## API-Endpunkte (von der App bereitgestellt)

Die Workflows rufen folgende App-Endpunkte auf — siehe
`apps/web/src/app/api/n8n/[...path]/route.ts` für Implementierung:

- `GET /api/n8n/overdue-requests` — JSON-Liste überfälliger Requests
- `GET /api/n8n/expiring-gwg-checks?withinDays=30` — JSON-Liste bald ablaufender GwG-Checks
- `GET /api/n8n/request-detail/<id>?tenantId=<tenantId>` — Detail eines Requests inkl. Mandant + Kontakt

App/Worker -> n8n: ausgehende Webhooks werden mit
`x-taxtronik-signature: sha256=<hex(hmac(event + "\n" + timestamp + "\n" + nonce + "\n" + body, N8N_HMAC_SECRET))>`
signiert. Die Header `x-taxtronik-event`, `x-taxtronik-timestamp` und
`x-taxtronik-nonce` sind Teil der Signatur.

n8n -> App: API-Aufrufe an `/api/n8n/*` erwarten
`x-taxtronik-signature: sha256=<hex(hmac(method + " " + pathAndSearch + "\n" + timestamp + "\n" + body, N8N_HMAC_SECRET))>`
plus `x-taxtronik-timestamp`.

## Versionierung

Diese Datei wird im Repo gepflegt. Beim Ändern eines Workflows in n8n:
1. Workflow exportieren (3-Punkt-Menü → Download)
2. Datei hier ersetzen
3. Commit + PR

So bleibt der Stand zwischen Installationen synchron.
