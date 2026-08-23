# ADR 0011 — n8n-Events: Outbox-Pattern statt fire-and-forget

**Status**: ~~Akzeptiert mit Re-Eval-Marker~~ → **Aktualisiert: Outbox umgesetzt
in Iter. 45 (S15)**, ursprüngliche fire-and-forget-Begründung historisch.
**Datum**: 2026-05-13 (initial), 2026-05-13 (Update nach Re-Review)
**Kontext**: Security-Review S15 hat angemerkt, dass `emitN8nEvent` heute
fire-and-forget ist — bei n8n-Ausfall gehen Events verloren. Für
Compliance-Workflows (Reminder, Eskalationen) wäre ein Outbox-Pattern mit
Retry sicherer.

## Entscheidung (revidiert)

Re-Review hat den Re-Eval-Trigger ausgelöst — wir haben den Outbox-Migrationspfad
genommen und das Pattern in Iter. 45 implementiert. Die ursprüngliche
fire-and-forget-Begründung ist unten als historische Diskussion erhalten,
weil sie die Trade-offs erklärt, die das pull-basierte n8n-Setup auch nach
der Outbox-Einführung weiter rechtfertigen.

**Aktueller Stand (Iter. 45 / S15)**:

- Jedes `emitN8nEvent` schreibt in `n8n_outbox` (RLS, FORCE) und reiht einen
  BullMQ-Job in `n8n-deliver` ein
- Worker [jobs/n8n-deliver.ts](../../apps/worker/src/jobs/n8n-deliver.ts) liefert
  mit Exponential-Backoff (6 Versuche). Bei Erfolg: `status=DELIVERED`. Bei
  Ausschöpfung: `status=FAILED`, Reihe bleibt für Ops-Inspektion erhalten.
- Reconcile-Job alle 5 Minuten fängt stuck `PENDING`-Reihen (App-Crash
  zwischen Outbox-Write und Queue-Add)
- `pingN8nWebhook` (Test-Button) umgeht die Outbox bewusst — synchroner
  Sofort-Fehler statt vertröstete Async-Lieferung.

## Historische Diskussion (fire-and-forget)

## Begründung

### Was n8n heute macht (Iter. 2)

- Reminder-Mails (Anforderungs-Fälligkeit, GwG-Ablauf)
- Geburtstags-/Jubiläums-Notifications
- Eskalationen bei überfälligen Vorgängen
- Mailversand-Workflows mit Mehrstufen-Logik

**Keiner dieser Workflows ist transaktionskritisch.** Wenn n8n ein Event
für eine fällige Anforderung verpasst, schickt der nächste tägliche Cron-Job
(in n8n selbst) trotzdem den Reminder, weil er die App-DB über das
`/api/n8n/overdue-requests`-Endpoint abfragt und alle überfälligen
Anforderungen sieht.

Sprich: **n8n ist primär pull-basiert** (über die `/api/n8n/*`-Endpoints),
und die App-Events sind nur ein "nice-to-have-Trigger" für schnellere
Reaktionen. Verpasste Events führen zu maximal 24h Verzögerung, nicht zu
verlorenen Vorgängen.

### Was eine Outbox kosten würde

- Tabelle `outbox_event` mit `(id, event, payload, status, attempts, nextAt)`
- Worker-Loop, der pending Events fetched und an n8n weiterleitet
- Retry-Logik mit Exponential-Backoff
- Dead-Letter-Queue für unzustellbare Events
- UI für Ops, um stuck Events einzusehen/manuell zu retriggern
- RLS-Policies auf `outbox_event` (Tenant-Discriminator)
- Cleanup-Job für alte erfolgreiche Events

Schätzaufwand: 2–3 Wochen, plus laufende Wartung.

### Wann das ein Problem wird

Wenn ein Tenant einen Workflow baut, der **nur durch ein Event ausgelöst
werden kann** (z. B. "schicke sofort eine SMS bei `request.opened`") UND
n8n-Downtime nicht toleriert. Aktuell hat kein Tenant so einen Workflow.

## Konsequenzen der Outbox-Umsetzung

**Was wir tun**

- `emitN8nEvent` schreibt in `n8n_outbox` und reiht einen BullMQ-Job ein. Der
  Aufrufer wartet den Outbox-Write ab, nicht die HTTP-Zustellung an n8n.
- Zustellungen werden nachgehalten, sofern die Outbox-Tabelle geschrieben
  werden konnte. Bei einem Write-Fehler liefert der Emit-Pfad `WRITE_FAILED`
  und die bereits abgeschlossene Geschäftslogik läuft entsprechend der alten
  Semantik weiter. Workflow-Schritte besitzen zusätzlich einen in derselben
  Fachtransaktion persistierten Dispatch-Intent, den ein eigener Reconciler in
  die Outbox überführt.
- Bei n8n-Ausfall: 6 Versuche mit Exponential-Backoff; nach Ausschöpfung bleibt
  die Zustellung als `FAILED` für die operative Behandlung erhalten.
- Die versionierten Pull-Endpunkte
  (`/api/integrations/n8n/v1/overdue-requests`,
  `/api/integrations/n8n/v1/expiring-gwg-checks`) lesen den aktuellen
  Fachzustand tenantgebunden. Die gleichnamigen `/api/n8n/*`-Routen sind nur
  ein standardmäßig deaktivierter Legacy-Pfad.

**Warum trotzdem pull-first bleibt**

- n8n-Ausfall > 1h ist real (Wartung, Crash, Tenant-Misconfig). Pull-Pfad
  kann den aktuellen Fachzustand nach der Wiederherstellung erneut lesen;
  Push-Outbox und Pull erfüllen unterschiedliche Zwecke.
- DSGVO-Lösch-/Vergessen-Operationen sollen nicht via Event-Replay reaktiviert
  werden — wer Daten löscht, will sie weg, auch wenn n8n offline war.
  Reconcile-Pull funktioniert dafür sauberer.

## Historische Verworfene Alternativen (vor Iter. 45)

- ~~**Sofort Outbox bauen**~~: war damals Premature Engineering, ist jetzt
  begründet (n8n nimmt sicherheitskritische Eskalationen mit auf, siehe
  S15-Re-Review).
- **n8n als Single Source of Truth für Workflows**: weiterhin abgelehnt.
  Aktuelles Setup ist robuster: fällt n8n aus, läuft die App weiter,
  eine erfolgreich persistierte Outbox beziehungsweise ein Workflow-Dispatch-
  Intent wird nach Wiederherstellung erneut zugestellt.
