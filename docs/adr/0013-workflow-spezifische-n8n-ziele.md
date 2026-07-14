# ADR 0013 — Workflow-spezifische n8n-Ziele und explizites Event-Routing

**Status**: Akzeptiert
**Datum**: 2026-07-14
**Bezug**: Verfeinert [ADR 0006](0006-n8n-statt-eigencode-fuer-workflows.md)
und [ADR 0011](0011-n8n-fire-and-forget-statt-outbox.md)

## Kontext

Die bisherige Konfiguration besitzt eine zentrale Webhook-Basis und bildet die
Ziel-URL als `<basis>/<event>`. Dieses Modell setzt stillschweigend
voraus, dass eine zentrale Router-Instanz jeden Eventnamen als Pfad kennt.
Tatsächlich gehört eine n8n-Production-Webhook-URL aber zu genau einem
veröffentlichten Webhook-Knoten beziehungsweise Workflow.

Damit bleiben wesentliche Fragen unbeantwortet:

- Welcher Workflow empfängt welches Event?
- Wie werden eigene Kanzlei-Workflows neben mitgelieferten Workflows
  registriert?
- Wie wird ein Event unabhängig an mehrere Workflows zugestellt?
- Welches Ziel ist unveröffentlicht, fehlerhaft oder bewusst pausiert?
- Welche Zustellung darf bei einem Retry dedupliziert werden?

Instanz-UI, n8n-Management-API, Webhook-Präfix und konkrete
Production-Webhook-URL sind außerdem verschiedene Vertrauens- und
Ausfallgrenzen. Eine einzige URL kann diese Rollen nicht sauber ausdrücken.

## Entscheidung

### Verbindung und Routing werden getrennt

Die optionale **Instanzverbindung** enthält:

- UI-URL für die Navigation aus TaxTronik,
- API-URL plus verschlüsselten API-Key für Workflow-Liste, Prüfung und
  selektiven Import; keine automatische Veröffentlichung,
- HMAC-Secret für TaxTronik → n8n,
- tenantgebundene Callback-Key-ID, gehashtes Bearer-Token und minimale
  Callback-Scopes für n8n → TaxTronik,
- eine separat gespeicherte, aus der n8n-Laufzeit erreichbare App-Basis für
  Callbacks und Workflow-Importe (`BUNDLED` standardmäßig
  `http://app:3000`, im lokalen Dev-Stack
  `http://host.docker.internal:3000`, extern eine öffentliche
  Staff-/API-Adresse),
- eine Legacy-Webhook-Basis ausschließlich für die Migration.

Das **Routing** besteht dagegen aus workflow-spezifischen Endpoints mit einer
exakten Production-Webhook-URL und Event-Abonnements. Ein Endpoint kann
mitgeliefert/verwaltet oder kanzleieigen sein; der Transport behandelt beide
gleich. Pro Endpoint und Event existiert höchstens ein Abonnement, mehrere
Endpoints dürfen dasselbe Event abonnieren.

Eine Test-URL mit `/webhook-test/` kann für eine interaktive Probe
angezeigt, aber nicht als aktives Produktionsziel verwendet werden. Aktiv ist
ein Ziel erst nach Veröffentlichung des n8n-Workflows, erfolgreichem
synthetischem Test und bewusster Freigabe. Neue Ziele sowie Änderungen an
Production-URL, Test-URL oder Eventauswahl werden serverseitig immer als
deaktivierter Entwurf gespeichert und verwerfen den bisherigen Prüfnachweis.
Auch ein solcher tenantgebundener Entwurf ist testbar. Aktivierung ist erst in
einem zweiten, inhaltlich unveränderten Speichervorgang nach erfolgreichem Test
möglich.

Verwaltete Workflow-JSONs enthalten nur markierte Platzhalter für nicht
geheime, installationsspezifische Werte. Der selektive TaxTronik-Import
materialisiert App-Basis, Callback-Key-ID und Mail-Adressen vor der Übergabe an
n8n. Secrets werden nie in das JSON geschrieben, sondern anschließend als
n8n-Credentials zugeordnet. Damit benötigen die Vorlagen weder freigegebenen
`$env`-Zugriff noch die editionsabhängigen Custom Variables
(`$vars`) und bleiben mit n8n Community betreibbar.

### Routing-Modi

- `EXPLICIT` ist das Zielmodell. Jedes aktive Abonnement erzeugt
  eine unabhängige Zustellung.
- `LEGACY` bildet vorübergehend weiterhin
  `<webhookBaseUrl>/<event>`. Es dient nur der Migration bestehender
  Installationen.
- `DISABLED` ist eine bewusste Betriebsentscheidung. Es findet kein
  HTTP-Aufruf statt; der Versuch wird nachvollziehbar als `SKIPPED`
  abgeschlossen.

Gibt es in `EXPLICIT` für ein bereits konfiguriertes Event vorübergehend kein
aktives Abonnement, wird das Event `UNROUTED` statt stillschweigend verworfen.
Ein Katalogevent, das noch nie abonniert wurde, ist dagegen bewusst nicht Teil
der n8n-Integration und wird nachvollziehbar als `SKIPPED` abgeschlossen. So
erzeugen opt-in Workflows keine Alarme für sämtliche übrigen Fachereignisse.
Fan-out-Ziele beeinflussen sich nicht gegenseitig.

### Transportidentität und Status

Der versionierte Envelope lautet:

```json
{
  "schemaVersion": 1,
  "eventId": "<n8n_outbox.id>",
  "deliveryId": "<n8n_delivery.id>",
  "event": "request.opened",
  "tenantId": "<tenant-id>",
  "occurredAt": "<ISO-8601>",
  "payload": {}
}
```

`eventId` identifiziert das fachliche Outbox-Ereignis und bleibt über
alle Ziele gleich. `deliveryId` identifiziert genau die Kombination
aus Ereignis und Ziel und bleibt über deren Retries stabil. Zusätzlich wird
`x-taxtronik-delivery-id` gesendet. Nonce und Timestamp bleiben
Replay-Schutz des einzelnen signierten HTTP-Versuchs und sind keine
fachlichen Deduplizierungsschlüssel.

Zustellstatus je Ziel:
`PENDING | DELIVERED | FAILED | SKIPPED`.

Aggregatstatus des Events:
`PENDING | DELIVERED | FAILED | PARTIAL | UNROUTED | SKIPPED`.

Die Semantik ist at least once. Empfänger müssen Seiteneffekte dauerhaft und
fehlertolerant nach `deliveryId` idempotent machen. Eine begrenzte
Remove-Duplicates-Historie ist keine Zustellgarantie, weil sie volllaufen und
bei Fehlern vorzeitig einen Schlüssel verbrauchen kann. `DELIVERED` bestätigt
die HTTP-Annahme, nicht automatisch den fachlichen Erfolg aller nachfolgenden
n8n-Nodes.

### Sicherheits- und Datenschutzgrenze

- App/Worker → n8n bleibt HMAC-signiert. Neue n8n → TaxTronik-Aufrufe
  verwenden die versionierte Callback-API
  `/api/integrations/n8n/v1/*` mit tenantgebundener Key-ID,
  Bearer-Token, Scope und pro Fachaufruf eindeutiger, über Retries stabiler
  Request-ID; Legacy-HMAC-Routen bleiben nur für die Migration. Parallele
  Duplikate werden blockiert, erfolgreich abgeschlossene Write-Callbacks
  idempotent bestätigt.
- n8n erhält keinen direkten Datenbankzugriff.
- Das Callback-Credential erhält nur benötigte Scopes
  (`requests:read`, `gwg:read`,
  `research:write`, `inbound-mail:write`). Ein
  n8n-Management-API-Key und das Outbound-HMAC-Secret sind davon getrennt.
- HMAC und Bearer-Token verschlüsseln nicht. Externe Verbindungen benötigen
  TLS.
- Der gemeinsame Eventkatalog klassifiziert jedes statische Event und liefert
  ausschließlich synthetische Beispielpayloads. Eine Workflow-Freigabe muss
  zusätzlich § 203 StGB, DSGVO, Ausführungsdaten-Retention und mögliche
  Drittziele bewerten.

## Konsequenzen

### Positiv

- Eigene Workflows werden explizit und ohne Pfadkonvention registriert.
- Fan-out, Status und Fehlerbehebung sind pro Workflow nachvollziehbar.
- API-Ausfall und Webhook-Ausfall können getrennt diagnostiziert werden.
- Stabile IDs ermöglichen sichere Retries und Deduplizierung.
- „Nicht eingerichtet" und „bewusst deaktiviert" sind unterscheidbar.

### Kosten und Risiken

- Zusätzliche persistente Entitäten, Migration und Bedienoberfläche.
- Jede neue Route braucht Freigabe, synthetischen Test und Betriebsmonitoring.
- Ein falsch gebauter Workflow kann trotz korrekter Transportzustellung
  fachlich scheitern; TaxTronik kann nur die Annahme beobachten.
- Legacy- und Explicit-Modus müssen während der Migration beide getestet
  werden, dürfen aber nicht gleichzeitig dasselbe Event doppelt zustellen.

## Migration

1. Bestehende Basis-URL als `LEGACY` markieren; nicht automatisch
   als Production-Endpoint interpretieren.
2. Veröffentlichte Webhook-Workflows inventarisieren und ihre exakten
   Production-URLs erfassen.
3. Events explizit abonnieren, mit synthetischen Payloads testen und
   Datenschutzfreigabe dokumentieren.
4. Auf `EXPLICIT` umstellen und `PARTIAL`,
   `FAILED` sowie `UNROUTED` überwachen.
5. Legacy-Basis erst nach erfolgreichem Parallelvergleich aus der
   Tenant-Konfiguration entfernen; es erfolgt kein paralleler Doppelversand.

## Verworfene Alternativen

- **Globale Basis plus Eventpfad beibehalten:** bildet Workflow-Eigentum,
  Publish-Zustand und Fan-out nicht ab.
- **Einen verpflichtenden zentralen Router-Workflow vorschalten:** verlagert
  Konfiguration und Single Point of Failure nach n8n und macht Einzelstatus
  unsichtbar. Eine Kanzlei darf einen solchen Router weiterhin als bewusstes
  eigenes Ziel registrieren.
- **Nur n8n-Management-API verwenden:** Zustellung würde unnötig von API-Key,
  Edition und API-Verfügbarkeit abhängen.
- **Beliebige Ziel-URL direkt am TaxTronik-Fachworkflow:** vermischt
  Fachkonfiguration, Secrets und Integrationsbetrieb und erschwert zentrale
  Datenschutzfreigabe.
