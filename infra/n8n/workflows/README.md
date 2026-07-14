# n8n-Workflows für TaxTronik

Die Dateien in diesem Verzeichnis sind inaktive, prüfbare Vorlagen. Sie enthalten
weder Secrets noch feste n8n-Credential-IDs. TaxTronik importiert Vorlagen nur;
Credentials zuordnen, fachliche Wirkung prüfen und veröffentlichen bleibt eine
bewusste Administrator-Aktion in n8n.

## Empfohlenes Setup

1. In TaxTronik als Administrator **Einstellungen → n8n-Integration** öffnen.
2. n8n-Oberfläche, API-URL und API-Key eintragen. Für TaxTronik → n8n ein
   zufälliges **Outbound-Signatur-Secret** erzeugen und sofort sicher kopieren.
3. Die Verbindung speichern. Unter **Rückkanal n8n → TaxTronik** nur die
   benötigten Scopes auswählen und das Callback-Token erzeugen. Token und Key-ID
   werden gemeinsam nur in diesem Moment vollständig angezeigt.
4. Die gewünschten Vorlagen bevorzugt über TaxTronik importieren. Der
   Importassistent ersetzt dabei die unten beschriebenen nicht geheimen Tokens.
5. Bei einem manuellen Import über **Workflows → Import from File** die sichtbaren
   `__TAXTRONIK_*__`-/Mail-Platzhalter direkt in den betroffenen Node-Feldern
   ersetzen.
6. In n8n die unten beschriebenen Credentials anlegen und an jedem importierten
   Node das passende Credential auswählen. Danach den
   Workflow prüfen und erst dann veröffentlichen.
7. Für Webhook-Workflows die exakte Produktions-URL des Webhook-Nodes als Route
   in TaxTronik speichern und die gewünschten Events zuordnen. Die `/webhook-test/`
   URL ist ausschließlich für einen laufenden manuellen n8n-Test bestimmt.
8. Zuerst `00-connection-test.json` veröffentlichen und den Zustelltest in
   TaxTronik ausführen.

TaxTronik aktiviert und überschreibt keinen Workflow automatisch. Das schützt
eigene Änderungen und verhindert, dass eine importierte Vorlage unbemerkt
fachliche Aktionen ausführt.

## Credentials in n8n

### 1. `TaxTronik Outbound HMAC` (Crypto)

Credential-Typ: **Crypto**. Im Feld **HMAC Secret** das Outbound-Signatur-Secret
aus TaxTronik eintragen. Dieses Credential den Crypto-Nodes in `00`, `03` und
`04` zuordnen.

Das Secret gehört nicht in einen Code-Node, eine Workflow-Variable oder die
n8n-Prozessumgebung. Die Compose-Konfiguration blockiert den Zugriff von Nodes
auf Environment-Variablen absichtlich.

### 2. `TaxTronik Callback` (Generic Header Auth)

Credential-Typ: **Generic Credential Type → Header Auth**:

- Name: `Authorization`
- Value: `Bearer <das einmalig angezeigte Callback-Token>`

Dieses Credential allen HTTP-Request-Nodes zuordnen, die
`/api/integrations/n8n/v1/*` aufrufen. Die nicht geheime Key-ID wird getrennt im
Header `x-taxtronik-key-id` übertragen.

### 3. SMTP

Für `01` und `02` ein SMTP-Credential der Kanzlei anlegen und den jeweiligen
Send-Email-Nodes zuordnen. Die Vorlagen bringen bewusst kein Credential mit.

## Nicht geheime Import-Tokens

Die Vorlagen verwenden keine `$vars`-Ausdrücke: Custom Variables stehen im
self-hosted n8n Community-Setup nicht zur Verfügung. Stattdessen materialisiert
der TaxTronik-Import diese klar erkennbaren Tokens, bevor er den Workflow an n8n
sendet:

| Token                           | Wert                                                       | Vorlagen         |
| ------------------------------- | ---------------------------------------------------------- | ---------------- |
| `__TAXTRONIK_API_URL__`         | Von n8n erreichbare TaxTronik-URL ohne abschließenden `/`  | `01`, `02`, `04` |
| `__TAXTRONIK_CALLBACK_KEY_ID__` | Nicht geheime Key-ID des tenantgebundenen Callback-Zugangs | `01`, `02`, `04` |
| `__SMTP_FROM__`                 | Absenderadresse der Kanzlei                                | `01`, `02`       |
| `__GWG_OFFICER_EMAIL__`         | Empfängeradresse der GwG-Warnung                           | `02`             |

Beim manuellen Dateiimport bleiben die Tokens absichtlich sichtbar. Sie müssen
in den URL-, Header- bzw. Mail-Feldern der Nodes ersetzt werden, bevor der
Workflow veröffentlicht wird. Es sind keine Secrets: Bearer-Token, HMAC-Secret
und SMTP-Passwort bleiben ausschließlich in n8n-Credentials.

Im Produktiv-Compose-Netz ist die API-URL üblicherweise `http://app:3000`. In
der lokalen Docker-Desktop-Entwicklung kann
`http://host.docker.internal:3000` passend sein. Bei n8n Cloud muss eine von
n8n Cloud erreichbare HTTPS-URL verwendet werden.

## Ausgelieferte Workflows

| Datei                      | Trigger                           | Verhalten                                                                                                 |
| -------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `00-connection-test.json`  | Webhook `taxtronik.ping`          | Prüft Signatur, Frische und Envelope und antwortet mit einer nebenwirkungsfreien synthetischen Challenge. |
| `01-request-reminder.json` | Cron Mo–Fr 09:00                  | Ruft tenantgebunden überfällige Anforderungen ab und sendet Erinnerungen ohne internen Portal-Link.       |
| `02-gwg-expiry-check.json` | Cron täglich 08:00                | Ruft tenantgebunden bald ablaufende GwG-Prüfungen ab und warnt den GwG-Beauftragten.                      |
| `03-request-opened.json`   | Webhook `request.opened`          | Prüft und bestätigt das Event. Es sendet bewusst keine zweite Mandanten-Mail.                             |
| `04-risk-research.json`    | Webhook `risk.research_requested` | Gestoppte, inaktive Vorlage. Der Recherche-Node muss vor einer Aktivierung fachlich ersetzt werden.       |

`04` verarbeitet nur den bereits anonymisierten Rechercheauftrag. Die
`researchRequestId` muss unverändert im Callback zurückgegeben werden, damit
TaxTronik Ergebnis, Mapping und ursprüngliche Markierung sicher zuordnen kann.

## Rückkanal n8n → TaxTronik (v1)

Der Tenant wird ausschließlich aus dem Callback-Credential ermittelt. Eigene
Workflows dürfen deshalb keinen `tenantId` in Query oder Body senden.

Jeder Aufruf benötigt:

- `Authorization: Bearer <Token>` über das Header-Auth-Credential
- `x-taxtronik-key-id: <Key-ID>`
- `x-taxtronik-request-id: <eindeutige ID>`

Die Request-ID muss mit Buchstabe oder Ziffer beginnen, darf höchstens 200
Zeichen enthalten und nur aus Buchstaben, Ziffern, `.`, `_`, `:` und `-`
bestehen. Sie muss pro fachlichem Aufruf einschließlich aller HTTP-Retries
stabil und zwischen verschiedenen Aufrufen eindeutig sein. Während der erste
Aufruf noch läuft, antwortet TaxTronik auf ein Duplikat mit HTTP 409 und
`Retry-After`. Nach erfolgreichem Abschluss liefern die beiden Write-Routen
`research-result` und `request-inbound` bei derselben ID idempotent HTTP 200
mit `duplicate: true`, ohne den Side Effect erneut auszuführen;
`research-result` gibt dabei auch die ursprüngliche `resultId` zurück. Der
Erfolgsbeleg wird atomar mit dem fachlichen Write in der Datenbank gespeichert,
sodass auch Redis-Neustarts keine Doppelmutation erlauben. Die Read-Routen
bleiben bei 409. Bei nicht verfügbarem Replay-Store antwortet TaxTronik
fail-closed mit HTTP 503.

| Endpoint                                                         | Scope                | Zweck                                     |
| ---------------------------------------------------------------- | -------------------- | ----------------------------------------- |
| `GET /api/integrations/n8n/v1/overdue-requests`                  | `requests:read`      | Überfällige Anforderungen                 |
| `GET /api/integrations/n8n/v1/expiring-gwg-checks?withinDays=30` | `gwg:read`           | Ablaufende GwG-Prüfungen                  |
| `GET /api/integrations/n8n/v1/request-detail/<id>`               | `requests:read`      | Tenantgebundene Details einer Anforderung |
| `POST /api/integrations/n8n/v1/research-result`                  | `research:write`     | Rechercheergebnis zuordnen                |
| `POST /api/integrations/n8n/v1/request-inbound`                  | `inbound-mail:write` | Validierte E-Mail-Antwort übernehmen      |

Mailziele werden nur für aktive Kontakte mit aktivierter
Benachrichtigungsfreigabe und nicht leerer E-Mail-Adresse geliefert. Das
Reminder-Ergebnis enthält dafür `signerEmail`/`contactName`; Request-Details
enthalten ausschließlich das Array `notifiableContacts` und bewusst keine
ungefilterten Top-Level-Felder `contactEmail` oder `contactName`.

Die POST-Bodies sind absichtlich klein und strikt validiert:

```json
{
  "researchRequestId": "UUID des ursprünglichen Auftrags (optional)",
  "title": "optional",
  "body": "Rechercheergebnis",
  "source": "optional"
}
```

```json
{
  "requestId": "UUID der Anforderung",
  "fromEmail": "bekannter aktiver Mandantenkontakt",
  "message": "Textantwort, maximal 5000 Zeichen"
}
```

Zusätzliche Felder – insbesondere `tenantId` – führen bei diesen v1-Callbacks
zu HTTP 400.

Für eigene Workflows sollten nur die tatsächlich benötigten Scopes in TaxTronik
aktiviert werden. Eine Token-Rotation macht das vorherige Token sofort
unbrauchbar; danach muss das n8n Header-Auth-Credential aktualisiert werden.

## TaxTronik → n8n (signierte Events)

TaxTronik signiert den exakten Request-Body mit:

```text
sha256=hex(hmac(event + "\n" + timestamp + "\n" + nonce + "\n" + body, secret))
```

Übertragen werden `x-taxtronik-event`, `x-taxtronik-timestamp`,
`x-taxtronik-nonce`, `x-taxtronik-delivery-id` und `x-taxtronik-signature`. Die
Vorlagen `00`, `03` und `04` berechnen den erwarteten HMAC mit dem offiziellen
n8n Crypto-Node und prüfen Event, Zeitfenster, Signatur, Nonce sowie die
Übereinstimmung der Delivery-ID in Header und Body.

Eigene Webhook-Workflows müssen diese Kette vor jede fachliche Verarbeitung
setzen. Das HMAC-Secret darf weder hardcodiert noch mit `$env` oder
`import crypto` in einem Code-Node verarbeitet werden.

Die Vorlagen verwenden bewusst nicht den n8n-Knoten **Remove Duplicates** als
Zustellgarantie: Dessen begrenzte Historie läuft voll und ein vor dem
Seiteneffekt gespeicherter Schlüssel kann fehlgeschlagene Ausführungen
vergiften. Fachliche Workflows müssen `body.deliveryId` stattdessen in einem
dauerhaften Idempotenzspeicher reservieren, den Seiteneffekt ausführen und den
Schlüssel erst zusammen mit dem erfolgreichen Ergebnis abschließen. Für den
TaxTronik-Callback nutzt Vorlage `04` dieselbe Delivery-ID als stabile
`x-taxtronik-request-id`.

## Legacy-Endpunkte

Die HMAC-gesicherten `/api/n8n/*`-Routen sind standardmäßig deaktiviert und
liefern `404`. Bestehende Installationen können sie ausschließlich für eine
befristete Migration mit `N8N_LEGACY_CALLBACKS_ENABLED=true` und einem starken
`N8N_HMAC_SECRET` freischalten. Neue oder angepasste Workflows verwenden
ausschließlich die tenantgebundenen, versionierten
`/api/integrations/n8n/v1/*`-Callbacks.
Die lesenden Legacy-Routen verlangen einen expliziten, mitsignierten
`tenantId`; insbesondere ist der frühere globale Aufruf von
`/api/n8n/expiring-gwg-checks` ohne Tenant nicht mehr zulässig. In
Multi-Tenant-Installationen lassen Legacy-Callbacks vollständig abgeschaltet.

## Datenschutz und Ausführungsdaten

Die Vorlagen speichern weder erfolgreiche noch fehlgeschlagene Execution-Daten.
Auch Compose deaktiviert die Payload-Historie und aktiviert Pruning. Wer diese
Werte für eine zeitlich begrenzte Diagnose ändert, muss mögliche Mandanten- und
Berufsgeheimnisdaten berücksichtigen und die Diagnose-Daten anschließend
löschen.

## Versionierung eigener Änderungen

Beim Weiterentwickeln einer Vorlage:

1. Workflow in n8n exportieren.
2. Secrets und Credential-Zuordnungen aus dem Export entfernen.
3. Erfolgs-/Fehlerhistorie auf `none` und den Workflow auf inaktiv setzen.
4. Datei ersetzen, Contract-Tests ausführen und die Änderung reviewen.

So bleibt der ausgelieferte Stand reproduzierbar, ohne lokale Secrets oder
n8n-Instanz-IDs ins Repository zu übernehmen.
