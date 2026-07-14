# ADR 0006 — n8n als Workflow-Engine, kein Eigencode für Reminder/Eskalationen

**Status**: Akzeptiert (Iteration 2), Implementierung in Iter. 45 verfeinert
**Datum**: 2026-05-10 (initial), 2026-05-13 (Update D1)

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
> 2. **HMAC-Formel ist um einen Timestamp erweitert** (Replay-Schutz, S3-Fix).
>    Die unten genannte Formel `hmac(METHOD pathname?search\nbody)` ist
>    historisch und stimmt nicht mehr mit dem Code überein. Aktuelle
>    Formeln, asymmetrisch:
>    - **Outbound (Web → n8n)**: `hmac(${ts}\n${body})` mit Headern
>      `x-taxtronik-signature` + `x-taxtronik-timestamp`.
>      Code: [sign.ts](../../apps/web/src/server/n8n/sign.ts).
>    - **Inbound (n8n → Web)**: `hmac(${METHOD} ${path}${search}\n${ts}\n${body})`
>      mit zusätzlichem Replay-Schutz via Redis-Nonce-Store
>      (Signatur als Nonce-Key, ±5 min Zeitfenster).
>      Code: [verify.ts](../../apps/web/src/server/n8n/verify.ts),
>      [nonce-store.ts](../../apps/web/src/server/n8n/nonce-store.ts).
>    - Asymmetrie absichtlich: n8n-Workflows können method/path nicht
>      trivial in HMAC einbeziehen.

**Kontext**: Eine Steuerberatungssoftware lebt von Kommunikation —
Anforderungs-Reminder, GwG-Ablauf-Warnungen, Mahn-Eskalationen,
Fristerinnerungen. Würden wir das in TypeScript bauen, wäre das eine
Eigenentwicklung mit Cron-Scheduler, E-Mail-Templating-Engine, Retry-Logik,
UI für Workflow-Anpassung… mehrere Mannmonate Wartung pro Jahr.

## Entscheidung

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
  `gwg.expired`, `invoice.due` → fire-and-forget POST an n8n
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

## Alternativen verworfen

- Eigener BullMQ-Cron-Worker für alle Mails (zu viele Templates,
  schlechte UI für Workflow-Anpassung)
- Zapier/Make (SaaS, kein On-Prem)
- Apache Airflow (Overkill für Mail-Workflows)
