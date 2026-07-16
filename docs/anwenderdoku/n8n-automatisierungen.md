# n8n-Automatisierungen einrichten und betreiben

Dieses Kapitel richtet sich an Administratoren und an Personen, die eigene
n8n-Workflows erstellen. TaxTronik bleibt das führende Fachsystem. n8n erhält
HMAC-signierte Ereignisse und darf TaxTronik ausschließlich über die
versionierten, tenantgebundenen Callback-Endpunkte unter
`/api/integrations/n8n/v1/*` ansprechen — niemals direkt über die
Datenbank.

## 1. Das Verbindungsmodell in einem Satz

Eine n8n-Instanz ist **nicht** gleichbedeutend mit einem Webhook: Jeder
Workflow besitzt eine eigene exakte Production-Webhook-URL. TaxTronik verwaltet
daher die Verbindung zur Instanz getrennt von den Workflow-Zielen und ihren
Event-Zuordnungen.

Fünf ähnlich aussehende URLs haben unterschiedliche Aufgaben:

| Begriff                           | Beispiel                                     | Wofür wird er verwendet?                                                             |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Instanz-UI**                    | `https://n8n.kanzlei.example`                | Anmeldung, Workflow-Editor und manuelle Kontrolle im Browser                         |
| **API-URL**                       | `http://n8n:5678/api/v1`                     | Optionale Verwaltung von Workflows durch TaxTronik; aus dem App-Container erreichbar |
| **Webhook-Präfix**                | `http://n8n:5678/webhook`                    | Technischer Präfix und Legacy-Kompatibilität; noch kein Workflow-Ziel                |
| **Exakte Production-Webhook-URL** | `http://n8n:5678/webhook/taxtronik-anfragen` | Das Ziel genau eines veröffentlichten Webhook-Workflows                              |
| **TaxTronik-Adresse aus n8n**     | `http://app:3000`                            | Rückweg und Importwert; aus der n8n-Laufzeit erreichbare TaxTronik-App               |

`localhost` bezeichnet in einem Container immer den Container selbst. Beim
mitgelieferten Produktions-Stack nutzt TaxTronik für App → n8n deshalb
`n8n:5678` und n8n für n8n → TaxTronik `app:3000`. Im lokalen Dev-Stack läuft
die App auf dem Host; dort lautet der vorausgefüllte Rückweg
`http://host.docker.internal:3000`. Eine öffentliche URL ist nur nötig, wenn
App und n8n nicht im selben vertrauenswürdigen Netz erreichbar sind.

## 2. Geführtes Setup in TaxTronik

Öffnen Sie **Administration → Einstellungen → n8n-Automatisierung**. Der Assistent
führt durch folgende Schritte:

1. **Betriebsart wählen:** n8n deaktivieren, eine vorhandene
   Legacy-Konfiguration vorübergehend weiterverwenden oder workflow-spezifische
   Ziele einrichten.
2. **Instanz verbinden:** Instanz-UI und optional API-URL plus API-Key
   hinterlegen. Der API-Zugang wird nur für Auflisten, Prüfen und Importieren
   verwalteter Workflows benötigt; Veröffentlichung und Credentials bleiben
   bewusste Schritte in n8n. Die Event-Zustellung funktioniert ohne API-Key.
3. **Workflow-Ziele als Entwurf speichern:** pro Workflow die
   **exakte Production-URL** speichern und die gewünschten Events abonnieren.
   Neue Ziele und Ziele mit geänderter URL oder Eventauswahl bleiben
   serverseitig deaktiviert, auch wenn im Formular bereits **Aktiv** gewählt
   wurde.
4. **Mit synthetischen Daten testen:** Auch ein deaktivierter, gespeicherter
   Entwurf kann getestet werden. Der Verbindungstest verwendet
   `taxtronik.ping` und darf nach Veröffentlichung auch die
   Production-URL prüfen. Fachliche Events sendet TaxTronik mit
   `synthetic: true` ausschließlich an die getrennte Test-URL — nie
   an Produktion, wo sie echte Seiteneffekte auslösen könnten. Keine echten
   Mandanten- oder Mitarbeiterdaten zum Testen verwenden.
5. **Unverändert aktivieren:** Nach einem erfolgreichen Test das Ziel erneut
   bearbeiten, **Aktiv** wählen und ohne Änderung an Production-URL, Test-URL
   oder Eventauswahl speichern. Jede spätere Änderung an diesen Feldern setzt
   den Nachweis zurück und macht das Ziel wieder zum deaktivierten Entwurf.
6. **Status prüfen und Entscheidung abschließen:** Alle benötigten Ziele müssen
   veröffentlicht, erreichbar, zuletzt erfolgreich getestet und anschließend
   aktiviert sein. Wer n8n nicht nutzt, wählt ausdrücklich **Deaktiviert**,
   damit die Inbetriebnahme-Checkliste nicht dauerhaft offen bleibt.

Das HMAC-Secret wird verschlüsselt gespeichert und nach dem Speichern nicht
mehr im Klartext angezeigt. Ein leer gelassenes Secret-Feld behält den
vorhandenen Wert; Rotation erfolgt nach dem
[Betriebs-Runbook](../operations/secret-rotation.md#n8n-secrets).

### API-Key und minimale Rechte

Wenn der Assistent Workflows verwalten soll, erzeugen Sie in n8n unter
**Settings → n8n API** einen eigenen, ablaufenden API-Key. Unterstützt Ihre
n8n-Edition Schlüssel mit Scopes, genügen typischerweise
`workflow:list`, `workflow:read` und
`workflow:create`. TaxTronik aktiviert oder veröffentlicht
importierte Vorlagen absichtlich nicht; deshalb weder `workflow:update`
noch `workflow:activate`, Benutzer-, Credential- oder
Execution-Schreibrechte vergeben. Editionen ohne API-Key-Scopes geben einem
Schlüssel weitreichenden Zugriff: dann einen dedizierten Service-Account
beziehungsweise ein eigenes n8n-Projekt verwenden, den Key besonders schützen
und kurz befristen.

Der API-Key ist **nicht** das HMAC-Secret und signiert keine Webhooks. Details:
[n8n API authentication](https://docs.n8n.io/api/authentication/).

### Importwerte und Credentials in n8n

Mitgelieferte Workflows enthalten absichtlich weder Secrets noch
installationsspezifische URLs. Die Vorlagen sind einzeln auswählbar. Vor dem
Import ersetzt TaxTronik die nicht geheimen Platzhalter:

- `__TAXTRONIK_API_URL__` und
  `__TAXTRONIK_CALLBACK_KEY_ID__` automatisch aus der eingerichteten
  Verbindung. Der erste Wert stammt aus dem separat gespeicherten Feld
  **TaxTronik-Adresse aus n8n**: beim mitgelieferten Compose-Betrieb
  in Produktion normalerweise `http://app:3000`, im lokalen Dev-Stack
  `http://host.docker.internal:3000` und bei einer externen oder
  Cloud-Instanz die aus deren Laufzeit erreichbare öffentliche
  TaxTronik-Adresse,
- `__SMTP_FROM__` aus **Mail-Absender in n8n**; bleibt das Feld leer,
  wird der TaxTronik-SMTP-Absender aus der Betreiberkonfiguration übernommen,
- und für Vorlage `02` `__GWG_OFFICER_EMAIL__` aus
  **E-Mail GwG-Verantwortliche**.

Prüfen Sie diese Werte in der Importvorschau; besonders
`localhost` ist aus dem n8n-Container fast immer falsch. Die
**TaxTronik-Adresse aus n8n** ist absichtlich unabhängig von der
Browser-/Login-Adresse und bleibt für spätere Importe gespeichert.
Anschließend ordnen Sie in n8n die Secrets als Credentials zu:

- Den Webhook-Workflows `00`, `03` und `04` ein
  **Crypto-Credential** mit demselben HMAC-Secret zu, das TaxTronik für
  Outbound-Events gespeichert hat.
- Den Callback-Workflows `01`, `02` und `04`
  ein **Generic Header Auth**-Credential mit
  `Authorization: Bearer <einmal angezeigtes Callback-Token>`.
- Den Mail-Nodes das passende SMTP-Credential.

TaxTronik blockiert im mitgelieferten n8n-Container den Zugriff von Nodes auf
Prozess-Umgebungsvariablen. Die Import-Materialisierung benötigt weder
`$env` noch die editionsabhängigen n8n Custom Variables
(`$vars`) und bleibt damit mit der mitgelieferten Community Edition
kompatibel. Geheimnisse gehören ausschließlich in n8n-Credentials, nicht in
Platzhalter oder Workflow-JSON. Siehe
[n8n custom variables und Editionen](https://docs.n8n.io/code/variables/) und
[HTTP Request credentials](https://docs.n8n.io/integrations/builtin/credentials/httprequest/).

Wer eine JSON-Datei manuell oder als Grundlage eines eigenen Workflows
importiert, pflegt diese Nicht-Geheimnisse direkt in URL-,
`x-taxtronik-key-id`- und Mail-Nodefeldern. Unersetzte
`__TAXTRONIK_*__`-Platzhalter sind ein Setup-Fehler; sie dürfen
nicht veröffentlicht werden.

## 3. Test-URL, Production-URL und Veröffentlichen

Ein Webhook-Knoten zeigt in n8n zwei URLs:

- Die **Test URL** enthält `/webhook-test/`. Sie ist nur während
  **Listen for Test Event** beziehungsweise einer manuellen Testausführung
  registriert. Für jede Route mit Fach-Events ist sie im getrennten
  Test-URL-Feld erforderlich; nur eine reine `taxtronik.ping`-Route kann ohne
  sie direkt an der Production-URL geprüft werden. Die Test-URL darf niemals
  als Production-URL oder aktives Zustellziel dienen.
- Die **Production URL** enthält normalerweise `/webhook/`. Sie wird erst
  erreichbar, wenn der Workflow veröffentlicht ist.

Speichern allein reicht nicht: n8n führt im Produktionsbetrieb die zuletzt
**veröffentlichte** Version aus. Nach jeder Änderung daher in n8n
**Publish** wählen, anschließend in TaxTronik die betroffene Route erneut
speichern und testen. TaxTronik hält eine neue oder geänderte Route zunächst
als deaktivierten Entwurf. Erst ein erfolgreicher Test setzt ihren
Prüfnachweis; danach kann sie durch unverändertes erneutes Speichern bewusst
aktiviert werden. Production-Tests sind auf das nebenwirkungsfreie
`taxtronik.ping` begrenzt; alle anderen Event-Beispiele gehen nur an
die separat gespeicherte Test-URL. Siehe
[Webhook node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/)
und [Save and publish](https://docs.n8n.io/workflows/publish/).

## 4. Mitgelieferte und eigene Workflows

**Verwaltete Workflows** werden mit TaxTronik ausgeliefert und können über den
Assistenten selektiv importiert werden. Ihre Aufgabe ist es, die benötigten
Credentials zuzuordnen, die angezeigte Production-URL als Ziel zu übernehmen,
zu veröffentlichen, als deaktivierten Entwurf zu speichern, zu testen und
danach unverändert zu aktivieren. Bereits vorhandene gleichnamige Workflows
werden nicht still überschrieben; Produktupdates können eine neue verwaltete
Vorlage bereitstellen.

**Eigene Workflows** gehören vollständig der Kanzlei. Legen Sie darin einen
Webhook-Knoten mit einer eindeutigen Route an, veröffentlichen Sie ihn und
tragen Sie dessen exakte Production-URL als neues Ziel ein. Wählen Sie danach
nur die Events, die dieser Workflow wirklich benötigt. Callback-App-URL und
Key-ID werden bei einem eigenen Workflow als nicht geheime Node-Konfiguration
gepflegt; Token und HMAC-Secret bleiben Credentials. Soll ein ausgelieferter
Workflow fachlich verändert werden, zuerst in n8n duplizieren und die Kopie als
eigenen Workflow registrieren; so bleiben Anpassungen bei Updates
nachvollziehbar.

Ein Event darf mehrere aktive Abonnements besitzen. TaxTronik erzeugt dann für
jede Route eine eigene Zustellung (**Fan-out**). Der Ausfall eines Ziels hält
die anderen Ziele nicht auf. Umgekehrt ist eine URL ohne Event-Abonnement kein
aktives Ziel.

## 5. Eventkatalog

Die Beispiele im Assistenten sind synthetisch und zeigen nur `payload`; der
Transport-Envelope kommt zusätzlich hinzu. Die Schutzklasse ist eine
Vorsortierung, keine Freigabe zur Weitergabe.

| Event                      | Anzeige/Kategorie                       | Bedeutung                                 | Datenklasse     | Datenschutz-Hinweis                                          |
| -------------------------- | --------------------------------------- | ----------------------------------------- | --------------- | ------------------------------------------------------------ |
| `client.created`           | Mandant angelegt · Mandanten            | Neue Mandantenakte                        | Berufsgeheimnis | Mandantenbezug; nur notwendige Daten nachladen               |
| `client.handover.ready`    | Mandantenübergabe bereit · Mandanten    | Übergabepaket ist bereit                  | Berufsgeheimnis | Kann umfangreiche Akteninhalte erschließen                   |
| `document.uploaded`        | Dokument hochgeladen · Dokumente        | Dokument wurde gespeichert                | Berufsgeheimnis | Metadaten und Inhalt können Steuer-/Personaldaten enthalten  |
| `request.opened`           | Anforderung eröffnet · Anforderungen    | Neue Unterlagen-/Informationsanforderung  | Berufsgeheimnis | Fachdetails nur über freigegebene Callbacks abrufen          |
| `request.responded`        | Anforderung beantwortet · Anforderungen | Anforderung wurde beantwortet             | Berufsgeheimnis | Antwort kann sensible Mandanteninformationen erschließen     |
| `request.closed`           | Anforderung geschlossen · Anforderungen | Anforderung wurde abgeschlossen           | Berufsgeheimnis | Kennung bleibt mandantenbezogen                              |
| `phone_note.created`       | Telefonnotiz angelegt · Kommunikation   | Neue Telefonnotiz                         | Berufsgeheimnis | Betreff und Inhalt nicht ungeprüft weiterleiten              |
| `appointment.responded`    | Termin beantwortet · Termine            | Termin wurde angenommen/abgelehnt         | Personenbezogen | Kalenderziel und Aufbewahrung prüfen                         |
| `gwg.invite.created`       | GwG-Einladung erstellt · Compliance     | GwG-Onboarding-Link wurde ausgestellt     | Berufsgeheimnis | Der geheime Link wird nie im Event-Payload übertragen        |
| `gwg.verified`             | GwG-Prüfung verifiziert · Compliance    | Berufsträger hat den Snapshot freigegeben | Berufsgeheimnis | Besonders schutzbedürftiger Compliance-Kontext               |
| `gwg.expired`              | GwG-Prüfung abgelaufen · Compliance     | GwG-Freigabe läuft ab oder entfällt       | Berufsgeheimnis | Besonders schutzbedürftiger Compliance-Kontext               |
| `invoice.due`              | Rechnung fällig · Rechnungen            | Rechnung ist fällig                       | Berufsgeheimnis | Beträge nur bei fachlicher Notwendigkeit abrufen             |
| `invoice.storno`           | Stornorechnung erstellt · Rechnungen    | Storno-/Korrekturbeleg wurde erstellt     | Berufsgeheimnis | Nicht wie eine fällige Zahlung behandeln                     |
| `staff.locked`             | Mitarbeiterkonto gesperrt · Mitarbeiter | Konto wurde gesperrt                      | Personenbezogen | Beschäftigtendaten nur an Berechtigte senden                 |
| `staff.vacation_requested` | Urlaub beantragt · Mitarbeiter          | Neuer Urlaubsantrag                       | Personenbezogen | Nur an entscheidungsberechtigte Stellen senden               |
| `risk.research_requested`  | Rechtsrecherche angefordert · Recherche | Anonymisierte Recherche freigegeben       | Berufsgeheimnis | Trotz Anonymisierung vertraulich und ggf. re-identifizierbar |
| `taxtronik.ping`           | Verbindungstest · System                | Synthetischer Transporttest               | Technisch       | Keine Echtdaten verwenden                                    |

Der Assistent zeigt zu jedem statischen Event unter **Payload-Beispiel und
Datenschutz** ein vollständig synthetisches JSON-Beispiel. Für eigene Workflows
sind in Schema-Version 1 insbesondere diese `payload`-Schlüssel vorgesehen:

- `client.created`: `tenantId`, `clientId`
- `client.handover.ready`: `tenantId`, `clientId`, `handoverId`, `label`
- `document.uploaded`: `tenantId`, `documentId`, `clientId`, `classification`, `isGobd`
- `request.opened`: `tenantId`, `requestId`, `clientId`, `priority`
- `request.responded`: `tenantId`, `requestId`, `by`
- `request.closed`: `tenantId`, `requestId`
- `phone_note.created`: `tenantId`, `noteId`, `forwardToStaff`, `subject`
- `appointment.responded`: `tenantId`, `kind`, `appointmentId`, `requestId`
- `gwg.invite.created`: `tenantId`, `clientId`, `gwgInviteId`, optional `gwgCheckId`;
  der geheime Link und sein Token werden ausdrücklich nicht übertragen
- `gwg.verified`: `tenantId`, `clientId`, `gwgCheckId`, `validUntil`
- `gwg.expired`: `tenantId`, `clientId`, `reason`
- `invoice.due` und `invoice.storno`: `tenantId`, `invoiceId`
- `staff.locked`: `tenantId`, `staffId`
- `staff.vacation_requested`: `tenantId`, `requestId`, `staffId`, `workdays`
- `risk.research_requested`: `researchRequestId`, `rechtsfrage`, `normAnker`,
  `governanceTyp`, `anonymizedText`, `katalogVersion`
- `taxtronik.ping`: `from`

Diese Beispiele beschreiben die von TaxTronik erzeugte Form, sind aber keine
Erlaubnis, beliebige Fachdaten an Dritte weiterzugeben. Workflows sollten
unbekannte zusätzliche Felder tolerieren und nur die fachlich benötigten
Schlüssel auswerten.

Workflow-Schritte können zusätzlich dynamische Events der Form
`workflow.step.<suffix>` auslösen. Der Suffix beginnt mit einem Kleinbuchstaben,
enthält nur Kleinbuchstaben, Ziffern, `_` oder `-` und ist höchstens 41 Zeichen
lang. Auch dafür muss ein explizites Abonnement existieren; die fachliche
Datenklasse bestimmt der selbst konfigurierte Schritt.

## 6. Zustellung, Wiederholungen und Deduplizierung

TaxTronik sendet jeden Aufruf in diesem Envelope:

```json
{
  "schemaVersion": 1,
  "eventId": "00000000-0000-4000-8000-000000000101",
  "deliveryId": "00000000-0000-4000-8000-000000000102",
  "event": "request.opened",
  "tenantId": "00000000-0000-4000-8000-000000000001",
  "occurredAt": "2026-07-14T09:30:00.000Z",
  "payload": {
    "requestId": "00000000-0000-4000-8000-000000000003",
    "clientId": "00000000-0000-4000-8000-000000000002",
    "priority": "NORMAL"
  }
}
```

`eventId` bleibt für ein fachliches Ereignis über alle Ziele gleich.
`deliveryId` bezeichnet die Zustellung an genau ein Ziel und bleibt auch bei
deren Wiederholungen gleich. Zusätzlich sendet TaxTronik
`x-taxtronik-delivery-id`, `x-taxtronik-event`, Timestamp, Nonce und die
HMAC-Signatur als Header.

Die Zustellung ist **at least once**: Bei Timeout oder Fehler kann derselbe
Aufruf erneut eintreffen. Jeder fachliche Workflow muss daher Seiteneffekte
dauerhaft nach `deliveryId` idempotent machen: Schlüssel reservieren,
Seiteneffekt ausführen und den erfolgreichen Abschluss gemeinsam speichern.
Der begrenzte n8n-Knoten **Remove Duplicates** ist dafür allein ungeeignet; er
kann volllaufen und bei Fehlern einen Schlüssel verbrauchen, obwohl die Aktion
nicht abgeschlossen wurde. Die Nonce verhindert Replay eines einzelnen
HTTP-Aufrufs, ist aber kein fachlicher Idempotenzschlüssel. Mit `2xx` soll n8n
erst antworten, wenn es die Zustellung erfolgreich verarbeitet oder einen
bereits erfolgreich abgeschlossenen Schlüssel erkannt hat.
Ein Status `DELIVERED` bestätigt den Transport, nicht automatisch den
fachlichen Erfolg aller nachfolgenden Nodes.

Für einen Produktionstest mit `taxtronik.ping` genügt nicht irgendeine
erfolgreiche HTTP-Antwort. TaxTronik erwartet JSON mit
`challenge: "taxtronik-connection-ok"` und `event: "taxtronik.ping"`; die
Vorlage `00` implementiert genau diesen nebenwirkungsfreien Handshake. Damit
kann eine fremde oder falsch geroutete `2xx`-Antwort keine Route verifizieren.

### Status richtig lesen

- **Routing-Modus `EXPLICIT`:** workflow-spezifische Ziele und Abonnements;
  empfohlener Normalbetrieb.
- **`LEGACY`:** Übergangsbetrieb über `<Webhook-Präfix>/<event>`; nur für
  bestehende Installationen, bis alle exakten Ziele erfasst sind.
- **`DISABLED`:** bewusst deaktiviert; neue Routingversuche werden ohne
  HTTP-Aufruf als `SKIPPED` dokumentiert.
- **Zustellung `PENDING`, `DELIVERED`, `FAILED`, `SKIPPED`:** Zustand je Ziel.
  Offene Fehler werden im Assistenten unabhängig von neueren Erfolgen zuerst
  und bei Bedarf seitenweise angezeigt. **Erneut versuchen** ist nur zulässig,
  solange Route, Ziel und Secret-Zuordnung unverändert aktuell sind. Ist eine
  alte Zustellung bewusst nicht mehr sendbar oder fachlich verworfen, schließt
  **Quittieren** sie ohne HTTP-Aufruf als `SKIPPED` ab; diese Entscheidung wird
  revisionsprotokolliert und löscht die gespeicherte Historie nicht vorzeitig.
- **Event `PENDING`, `DELIVERED`, `FAILED`, `PARTIAL`, `UNROUTED`, `SKIPPED`:**
  Aggregat über alle Ziele. `PARTIAL` bedeutet, dass nur ein Teil des Fan-outs
  erfolgreich war; `UNROUTED`, dass für ein ausdrücklich konfiguriertes Event
  derzeit keine zugehörige Route aktiv ist. Nie abonnierte Katalogevents sind
  bewusst nicht Teil der n8n-Integration und werden ohne Betriebsalarm als
  `SKIPPED` abgeschlossen. Nach dem Aktivieren einer passenden Route können berechtigte
  Admins einzelne offene `UNROUTED`-Events über **Jetzt zuordnen** bewusst an
  die nun aktiven Ziele materialisieren. Der Bestätigungsdialog nennt Alter
  und Datenschutzrisiko der gespeicherten Payload; TaxTronik tut dies nie
  stillschweigend. Fachlich nicht mehr gewünschte Events werden über **Nicht
  senden** auditiert als `SKIPPED` abgeschlossen.

Die Instanz-API kann nicht erreichbar sein, während bereits gespeicherte
Production-Webhooks weiterhin funktionieren. Ein API-Fehler ist deshalb ein
Verwaltungsproblem; entscheidend für den Versand sind die Einzelrouten und
deren letzte Zustellungen.

TaxTronik bewahrt terminale n8n-Outbox-Ereignisse mitsamt Payload und
Zustellzeilen begrenzt auf: `DELIVERED`, `SKIPPED` und `UNROUTED` 90 Tage,
`FAILED` und `PARTIAL` 180 Tage nach der letzten Änderung. Der tägliche
Retention-Job um 03:45 UTC löscht danach Outbox und zugehörige Zustellungen.
Aktive `PENDING`-/`PROCESSING`-Zustellungen sind ausdrücklich ausgenommen.
Die nur aus Hash und technischen IDs bestehenden Callback-Idempotenzbelege
werden nach 180 Tagen entfernt; danach darf eine alte Request-ID nicht erneut
verwendet werden.

## 7. Callback-Credential und Datenschutz

Für n8n → TaxTronik wird das Credential **TaxTronik Callback** verwendet. Der
Assistent erzeugt dafür:

- eine Callback-Basis der Form `.../api/integrations/n8n/v1`, aufgebaut aus
  der separat gespeicherten **TaxTronik-Adresse aus n8n**. Im mitgelieferten
  Produktionsnetz ist deren Standard `http://app:3000`, im lokalen Dev-Stack
  `http://host.docker.internal:3000`; für selbst betriebene oder
  Cloud-Instanzen muss sie aus der n8n-Laufzeit erreichbar sein,
- eine tenantgebundene `x-taxtronik-key-id`,
- ein langes Bearer-Token, das **nur einmal** angezeigt wird,
- und die ausgewählten Callback-Scopes.

Im ausgelieferten Workflow wird das Token vom Generic-Header-Credential als
`Authorization: Bearer ...` gesetzt; App-Basis und Key-ID wurden beim Import
als nicht geheime Node-Konfiguration materialisiert. Eigene Workflows müssen
für jeden fachlichen Versuch ebenfalls eine neue, bei Retries aber stabil
bleibende `x-taxtronik-request-id` setzen.

Jeder Callback sendet außerdem eine eindeutige, über HTTP-Retries stabile
`x-taxtronik-request-id`. Läuft der erste Aufruf noch, weist TaxTronik ein
Duplikat mit `409` und `Retry-After` zurück. Nach einem erfolgreichen
`research-result`- oder `request-inbound`-Write liefert ein Retry mit derselben
ID idempotent `200` und `duplicate: true`, ohne erneut zu schreiben; beim
Rechercheergebnis bleibt auch die ursprüngliche `resultId` erhalten. Der
Erfolgsbeleg wird in derselben Datenbanktransaktion wie die Fachänderung
gespeichert. Wiederholte Read-Aufrufe bleiben bei `409`. Ist der
Replay-Speicher nicht verfügbar,
schlägt die Prüfung geschlossen fehl. Ein vom Workflow übermitteltes
`tenantId` bestimmt niemals den Tenant — die Bindung folgt ausschließlich aus
der Key-ID.

Vergeben Sie nur benötigte Scopes:

| Scope                | Erlaubte Aufgabe                                                     |
| -------------------- | -------------------------------------------------------------------- |
| `requests:read`      | überfällige Anforderungen und freigegebene Anforderungsdetails lesen |
| `gwg:read`           | ablaufende GwG-Prüfungen lesen                                       |
| `research:write`     | Ergebnis einer freigegebenen Rechtsrecherche zurückschreiben         |
| `inbound-mail:write` | eingehende Mail als Anforderungsantwort verarbeiten                  |

Für Mail-Automatisierungen liefert TaxTronik ausschließlich aktive Kontakte
mit eingeschalteter Benachrichtigungsfreigabe und nicht leerer E-Mail-Adresse.
Anforderungsdetails stellen diese Empfänger nur unter `notifiableContacts`
bereit; eigene Workflows dürfen keine anderen Kontaktdaten als Mailziel
ableiten.

Das Callback-Credential nicht mit dem Outbound-HMAC-Secret oder dem
n8n-Management-API-Key verwechseln. Es darf nur die angezeigte
TaxTronik-Callback-Basis ansprechen und nicht an Nodes hängen, die fremde Hosts
aufrufen. Die alten HMAC-Endpunkte unter `/api/n8n/*` sind standardmäßig
vollständig deaktiviert und antworten ohne Authentifizierungsversuch mit `404`.
Sie dürfen nur für eine befristete Migration bestehender Workflows durch den
Betreiber mit `N8N_LEGACY_CALLBACKS_ENABLED=true` und einem starken
`N8N_HMAC_SECRET` freigeschaltet werden. Nach der Umstellung das Flag wieder
auf `false` setzen und App/Worker neu starten. Neue oder aktualisierte
Workflows nutzen immer die versionierte Callback-API.

Für Kanzleien gelten insbesondere DSGVO und die Verschwiegenheitspflicht nach
§ 203 StGB:

- Outbound-HMAC und Callback-Token authentisieren, verschlüsseln aber nicht.
  Außerhalb eines isolierten internen Netzes ist TLS Pflicht.
- Pro Workflow nur benötigte Events abonnieren und nur erforderliche Details
  nachladen. Keine komplette Akte „auf Vorrat“ übertragen.
- Zielsysteme, Unterauftragsverarbeiter und Drittlandtransfers vor Aktivierung
  prüfen; Vereinbarungen, Löschfristen und Berechtigungen dokumentieren.
- n8n-Ausführungsdaten enthalten häufig Payloads. Speicherung erfolgreicher
  Ausführungen minimieren, Fehlerdaten befristen und Zugang zur n8n-UI
  beschränken.
- Tests ausschließlich mit den synthetischen Beispielen durchführen. Auch der
  anonymisierte Recherche-Event bleibt vertraulich und kann durch Kontext
  re-identifizierbar sein.
- Secrets, Signaturen, Payloads und API-Keys nicht in Node-Namen, Notizen oder
  frei zugängliche Logs kopieren.

Credentials sollten n8n-intern gespeichert und projektbezogen freigegeben
werden; siehe [n8n Credentials](https://docs.n8n.io/credentials/) und
[RBAC roles](https://docs.n8n.io/user-management/rbac/role-types/).

## 8. Fehlerdiagnose

| Symptom                               | Wahrscheinliche Ursache                                                   | Maßnahme                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `404` am Ziel                         | Test-URL, falscher Pfad oder Workflow nicht veröffentlicht                | Production-URL im Webhook-Knoten kopieren, veröffentlichen, erneut testen             |
| `401`/`403`                           | Outbound-HMAC, Callback-Key/-Token/-Scope oder n8n-API-Key stimmt nicht   | Richtung unterscheiden, gespeichertes Credential prüfen, nicht blind Secrets ersetzen |
| `409` am Callback                     | Gleiche Request-ID läuft noch oder ein Read wurde wiederholt              | `Retry-After` beachten; keine neue Request-ID für denselben laufenden Write erzeugen  |
| `503` am Callback                     | Replay-Speicher nicht verfügbar                                           | Redis/TaxTronik-Verfügbarkeit beheben; nicht unsigniert umgehen                       |
| API-Status rot, Webhooks grün         | API-URL/Key/Scope falsch; gespeicherte Ziele arbeiten weiter              | API-Verbindung separat prüfen                                                         |
| Alle Ziele fehlerhaft                 | Instanz, Netz, TLS oder Outbound-HMAC-Secret                              | `doctor`, n8n-/Worker-Logs und Erreichbarkeit prüfen                                  |
| Nur ein Ziel fehlerhaft               | Exakte URL, Veröffentlichung oder einzelner Workflow                      | Ziel in n8n öffnen und dessen letzte Execution prüfen                                 |
| `200`, aber keine Wirkung             | Workflow-Zweig, Credential oder Callback nach Annahme fehlgeschlagen      | n8n-Execution und Callback-Antwort prüfen                                             |
| Doppelte Mail/Aktion                  | Workflow ist nicht idempotent                                             | Seiteneffekt und dauerhaften Abschluss nach `deliveryId` koordinieren                 |
| `UNROUTED`                            | Konfiguriertes Event, dessen Route derzeit nicht aktiv ist                | Bewusst **Jetzt zuordnen** oder auditiert **Nicht senden** wählen                     |
| Route bleibt deaktiviert              | Neu/geändert, noch kein erfolgreicher Test oder beim Aktivieren verändert | Entwurf testen; danach unverändert mit **Aktiv** erneut speichern                     |
| Alter Fehler lässt sich nicht retryen | Route, Ziel oder Secret-Zuordnung wurde seitdem geändert                  | Nicht an alten Snapshot senden; fachlich prüfen und bewusst **Quittieren**            |
| URL mit `localhost` nicht erreichbar  | Falscher Netzwerk-Namensraum im Container                                 | Compose-Service-DNS oder intern erreichbaren Host verwenden                           |

Bei Betrieb hinter einem Reverse Proxy müssen n8n insbesondere die externe
Webhook-Basis und die Anzahl vertrauenswürdiger Proxy-Hops bekannt sein; siehe
[Configure webhook URLs with reverse proxy](https://docs.n8n.io/hosting/configuration/configuration-examples/webhook-url/).
Der Betreiberpfad steht in
[Day-2 Operations](../operations/day-2-operations.md#n8n).

## 9. n8n bewusst deaktivieren

Vor dem Abschalten offene `PENDING`-/`FAILED`-Zustellungen prüfen und fachlich
entscheiden, ob sie noch zugestellt oder verworfen werden dürfen. Danach in
**Administration → Einstellungen → n8n-Automatisierung** den Modus **Deaktiviert**
wählen. TaxTronik führt seine Kernfunktionen weiter aus; neue n8n-Routen werden
als `SKIPPED` nachvollziehbar, aber nicht versendet. Eigene n8n-Zeitpläne und
Cron-Workflows zusätzlich direkt in n8n deaktivieren — der TaxTronik-Schalter
stoppt keine autonom laufenden n8n-Trigger.

Zum Wiederaktivieren zuerst Secret und Ziele prüfen, Workflows veröffentlichen,
synthetisch testen und erst dann auf `EXPLICIT` wechseln.

Die zusätzliche Aktion zum Bereinigen deaktiviert die Integration, bricht
wartende Zustellungen ab und entfernt Routen sowie Credentials. Ein
tenantgebundener, deaktivierter Marker bleibt absichtlich bestehen, damit eine
globale Legacy-ENV die Kanzlei-Konfiguration danach nicht unbemerkt reaktiviert.
