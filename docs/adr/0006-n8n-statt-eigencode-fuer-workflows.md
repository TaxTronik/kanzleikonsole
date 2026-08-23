# ADR 0006 — n8n als optionale Workflow-Engine neben Kernkontrollen im Worker

**Status**: Ursprüngliche Vollabgrenzung abgelöst; heutige Hybridentscheidung akzeptiert
**Datum**: 2026-05-10 (initial), 2026-05-13 (Update D1), 2026-08-23 (Hybridmodell)

> **Update 2026-08-23:** Die Aussage „n8n macht alle Cron-Jobs" und der Vorteil
> „0 Zeilen TypeScript für Reminder-Cron-Logik" sind abgelöst. Fristen,
> Retention, Audit, Backups, Rechnungsstatus und zwingende Erinnerungen laufen
> als versionierte, getestete BullMQ-Jobs im Worker. n8n bleibt für
> kanzleispezifische Kommunikation, Integrationen und konfigurierbare
> Eskalationsstrecken zuständig. Der aktuelle Überblick steht in
> `docs/architecture.md`; die historische Entscheidung bleibt unten erhalten.

> **Update 2026-05-13 (D1)** — Die Push-Pfad-Implementierung hat sich seit
> initialer Niederschrift weiterentwickelt. Die ursprünglichen Aussagen
> unter "Entscheidung" sind in zwei Punkten überholt; die strategische
> Verantwortungsabgrenzung selbst gilt weiter.
>
> 1. **Push-Pfad ist nicht mehr fire-and-forget**, sondern Outbox-basiert
>    (siehe [ADR 0011](0011-n8n-fire-and-forget-statt-outbox.md), Status
>    "Aktualisiert"). Jedes `emitN8nEvent` schreibt eine Reihe in
>    `n8n_outbox` und reiht einen BullMQ-Job ein, der mit Exponential-
>    Backoff zustellt. Code: [outbox.ts](../../apps/web/src/server/n8n/outbox.ts),
>    [jobs/n8n-deliver.ts](../../apps/worker/src/jobs/n8n-deliver.ts).
> 2. **Heutiger Sicherheitsvertrag ist richtungsabhängig:**
>    - **Outbound (Web/Worker → n8n)**:
>      `hmac(${event}\n${timestamp}\n${nonce}\n${body})` mit den Headern
>      `x-taxtronik-signature`, `x-taxtronik-timestamp`,
>      `x-taxtronik-event` und `x-taxtronik-nonce`. Code:
>      [`@taxtronik/n8n-shared`](../../packages/n8n-shared/src/index.ts).
>    - **Inbound-Standard (n8n → Web)**: `/api/integrations/n8n/v1/*`
>      verwendet ein tenantgebundenes Bearer-Credential mit Key-ID, minimalen
>      Scopes und einer einmaligen `x-taxtronik-request-id`; der Redis-
>      Replay-Store arbeitet fail-closed. Code:
>      [callback-auth.ts](../../apps/web/src/server/n8n/callback-auth.ts).
>    - Die globale HMAC-Verifikation unter `/api/n8n/*` ist nur ein
>      standardmäßig deaktivierter Legacy-Migrationspfad. Code:
>      [verify.ts](../../apps/web/src/server/n8n/verify.ts) und
>      [legacy-access.ts](../../apps/web/src/server/n8n/legacy-access.ts).

**Kontext**: Eine Steuerberatungssoftware lebt von Kommunikation —
Anforderungs-Reminder, GwG-Ablauf-Warnungen, Mahn-Eskalationen,
Fristerinnerungen. Würden wir das in TypeScript bauen, wäre das eine
Eigenentwicklung mit Cron-Scheduler, E-Mail-Templating-Engine, Retry-Logik,
UI für Workflow-Anpassung… mehrere Mannmonate Wartung pro Jahr.

## Ursprüngliche Entscheidung (historisch)

**n8n** läuft als eigener Container im Docker-Compose-Stack.

Verantwortungsabgrenzung:

- **App-Eigencode** macht nur synchrone, sicherheits-/integritäts-kritische
  Operationen: Hash-Chain-Audit, ClamAV-Scan, GwG-Trigger, RLS, Auth, PDF-
  Generierung. Plus: transaktionale Mails, die direkt aus dem Code raus
  müssen (z. B. Magic-Link beim Login-Klick).
- **n8n** macht alle Cron-Jobs (täglich, wöchentlich), Mail-Templates
  ohne Geschäftslogik, Mehrstufige Eskalationen, externe Integrationen
  (zukünftig: DATEV-API, Mahn-Dienste).

App ↔ n8n via signiertem HMAC:

- **App → n8n** (Webhook): bei Events `client.created`, `request.opened`,
  `gwg.invite.created`, `gwg.verified`, `gwg.expired`, `invoice.due` →
  transaktionale Outbox-Zustellung an n8n
- **n8n → App** (HTTP-API): n8n liest/schreibt nur über `/api/n8n/*`-Endpunkte
  mit `x-taxtronik-signature: sha256=hmac(METHOD pathname?search\nbody)`.
  Kein direkter DB-Zugriff (= RLS, Audit konsistent)

Workflows liegen als JSON in `infra/n8n/workflows/` versioniert im Repo;
Änderungen via Export → Commit.

## Konsequenzen

**Vorteile**

- 0 Zeilen TypeScript für Reminder-Cron-Logik
- Kanzlei kann Workflows selbst anpassen (Mailtext, Schwellwerte) ohne
  Re-Deployment
- Bewährte Engine, gute UI, große Community

**Nachteile**

- Ein zusätzlicher Container (RAM ~150MB, Postgres-DB `n8n`)
- HMAC-Auth muss überall stimmen (typisches Setup-Stolperstein)
- n8n-Workflows sind nicht versionsgetestet wie unser TS-Code
  → Mitigation: JSON-Versionierung im Repo, Import-Skript prüft Version
  beim Container-Start (geplant für Iter. 8)

## Heutige Verantwortungsgrenze

- **BullMQ-Worker:** fachlich zwingende und prüfungsrelevante Zeitpläne,
  insbesondere Steuerfristen, Wiedervorlagen, GwG/PoA, Rechnungen, Retention,
  Audit-Anker/-Verify/-Archiv, Backups und Infrastruktur-Health.
- **n8n:** tenantkonfigurierbare Event-Fan-outs, Mail-/Rechercheworkflows und
  externe Integrationen. Zugriff ausschließlich über signierte Outbox und
  gescopte Callback-APIs; kein direkter Datenbankzugriff.
- **App:** transaktionale Fachmutationen und unmittelbar erforderliche
  Basismails. Ein n8n-Ausfall darf keine bereits committete Fachmutation
  erfinden oder verschwinden lassen. Zustellungen werden nachgehalten, sobald
  Outbox oder — bei Workflow-Schritten — der transaktionale Dispatch-Intent
  dauerhaft geschrieben wurde. Ein generischer Event-Write-Fehler rollt die
  Fachmutation nicht zurück und muss operativ behandelt werden.

## Alternativen verworfen

- Eigener BullMQ-Cron-Worker für alle Mails (zu viele Templates,
  schlechte UI für Workflow-Anpassung)
- Zapier/Make (SaaS, kein On-Prem)
- Apache Airflow (Overkill für Mail-Workflows)
