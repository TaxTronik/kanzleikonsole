<p align="center">
  <img src="docs/assets/logo.svg" alt="TaxTronik" width="120" height="120" />
</p>

<h1 align="center">TaxTronik</h1>

<p align="center">Kanzlei- und Mandanten-Dashboard für deutsche Steuerberater. On-Premise-Software pro Kanzlei.</p>

## Was es kann (Endausbau)

- **Kanzlei-Dashboard**: Mitarbeiter (Zeiterfassung, Urlaub, Krankmeldung, Telefonzettel, eigene Ablage), Mandanten-CRM, Wissensdatenbank, Kanzleileitungs-Auswertungen, GwG-Compliance-Modul mit systemischer Schranke, Schulungsnachweise.
- **Mandanten-Portal**: Stammdaten, VZ-Soll mit Erinnerungen, Steuerschätzung (GewSt/USt/KSt/ESt) auf laufender BWA-Basis mit Szenarien, Unternehmenskennzahlen, Bescheide, Vollmachten mit Signatur, Rechnungen, Anforderungs-Upload.

Vollständige Architektur: [docs/architecture.md](docs/architecture.md).

## Tech-Stack

| Schicht | Wahl |
|---|---|
| Frontend / API | Next.js 16 (App Router, Turbopack) + TypeScript + shadcn/ui + Tailwind |
| Auth | Auth.js v5 — Mitarbeiter mit Pwd+TOTP-Pflicht, Mandanten mit Magic-Link |
| DB | Postgres 18 + Prisma + Row-Level Security |
| Storage | SeaweedFS (S3-API, Object-Lock COMPLIANCE für GoBD) + ClamAV-Virus-Scan — **nur Docker-intern, nie öffentlich**; die App streamt Up-/Downloads selbst |
| Workflows | n8n als Engine für Kommunikation/Reminder/Cron |
| Lokale Jobs | BullMQ-Worker (Virus-Scan, PDF, Hash-Versiegelung, BWA) |
| Deployment | Docker-Compose, On-Premise pro Kanzlei |

## Inbetriebnahme in einem Befehl

Voraussetzungen: **Docker Desktop installiert und gestartet**, sowie **Node.js 22.13+** mit **pnpm 11+** (Projekt pinnt `pnpm@11.1.2` via `packageManager` — am einfachsten `corepack enable`).

**Windows (PowerShell):**

```powershell
.\scripts\setup.ps1
```

**Linux / macOS / Git-Bash:**

```bash
./scripts/setup.sh
```

Das Skript erledigt automatisch:

1. Prüft Docker und pnpm.
2. Legt `.env` aus `.env.example` an und füllt zufällige Secrets (`AUTH_SECRET`, `N8N_HMAC_SECRET`, `N8N_ENCRYPTION_KEY`).
3. Fährt den Compose-Stack hoch: Postgres, Redis, SeaweedFS, ClamAV, Mailhog, n8n.
4. Wartet, bis Postgres healthy ist.
5. Installiert Node-Pakete.
6. Wendet Prisma-Migrationen an (Schema, RLS-Policies, Audit-Trigger).
7. Spielt einen Demo-Seed ein (Admin-Login + ein Beispiel-Mandant).
8. Legt Object-Store-Buckets an: `gobd` mit Object-Lock COMPLIANCE (10 Jahre, GoBD), `general`, `staff-private` (versioniert), `quarantine` (30-Tage-Lifecycle), `backups` (90-Tage-Lifecycle).

Anschließend Dev-Server starten:

```bash
pnpm --filter @taxtronik/web dev      # App auf http://localhost:3000
pnpm --filter @taxtronik/worker dev   # Hintergrund-Jobs
```

Login: <http://localhost:3000/staff/login>. Demo-Zugang siehe Seed-Output.

Hilfsdienste während der Entwicklung:

| Dienst              | URL                                  |
|---------------------|--------------------------------------|
| SeaweedFS-Master    | <http://localhost:9333>              |
| SeaweedFS-Filer-UI  | <http://localhost:8888>              |
| Mailhog (SMTP-UI)   | <http://localhost:8025>              |
| n8n (Workflows)     | <http://localhost:5678>              |

### Reset & weitere Optionen

```powershell
.\scripts\setup.ps1 -Reset        # alles löschen, dann neu (inkl. DB-Volumes)
.\scripts\setup.ps1 -SkipSeed     # ohne Demo-Daten
```

```bash
./scripts/setup.sh --reset
./scripts/setup.sh --skip-seed
```

### Was muss ich nach dem Setup noch tun?

Auf <http://localhost:3000/staff/admin> blendet sich oben eine **Setup-Checkliste** ein, solange noch Punkte offen sind (Erscheinungsbild, Bundesland, Kanzlei-Stammdaten, SMTP, Portal-Kontakte). Jeder Punkt verlinkt direkt zur passenden Einstellungsseite. Wenn alle erledigt sind, verschwindet die Karte automatisch.

Wichtige Stellen unter **Einstellungen**:

- **E-Mail-Versand**: SMTP-Daten der Kanzlei (Gmail/M365/IONOS/Strato/Telekom-Presets), Test-Mail-Button. Wenn nichts gepflegt ist, läuft Mailversand über die ENV-Vorgabe (im Dev: Mailhog).
- **Zeitstempel (TSA)**: Auswahl zwischen 7 vordefinierten RFC-3161-Anbietern (FreeTSA, DigiCert, Sectigo, GlobalSign, Apple, D-Trust eIDAS, Swisscom eIDAS) oder eigener URL. Mit Test-Roundtrip.
- **Integrationen**: Live-Status aller externen Dienste (Postgres, Object-Store, Redis, ClamAV, n8n, TSA).

## Quickstart für Entwickler (manuell)

Wenn Sie das Setup-Skript nicht nutzen möchten:

```bash
pnpm install
cp .env.example .env
# AUTH_SECRET füllen, z. B. `openssl rand -base64 32`
docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.dev.yml up -d
pnpm --filter @taxtronik/db prisma migrate deploy
pnpm --filter @taxtronik/db run seed
pnpm --filter @taxtronik/web dev
```

App läuft auf <http://localhost:3000>. SeaweedFS-Master auf <http://localhost:9333>.

## Produktiv-Deployment (On-Premise)

Der Stack läuft über den `dc`-Wrapper (kapselt die Compose-Dateien +
`--env-file`, rendert die SeaweedFS-S3-Config). `app`/`worker` nutzen ein
**vorgebautes Image** `taxtronik/{web,worker}:${TAXTRONIK_VERSION:-dev}` —
es gibt **kein** `build:` in der Compose, das Image wird per `docker build`
erzeugt.

> **Image-Tag:** Compose zieht den Tag aus `TAXTRONIK_VERSION` in der `.env`.
> Produktiv ist das `latest` (`TAXTRONIK_VERSION=latest`), **nicht** `dev`.
> Immer den Tag bauen, den die `.env` auflöst — sonst läuft der alte
> Container weiter (`docker ps` zeigt das tatsächliche Image).

### Voraussetzung: `.env`

Pflichtwerte für ein produktives Multi-Domain-Setup (Kanzlei- + Mandanten-
Subdomain). Fehlende/falsche Werte → kein Mail-Versand bzw. Mandanten-Domain
landet in der Mitarbeiter-Ansicht:

```ini
TAXTRONIK_VERSION=latest
NEXTAUTH_URL=https://kanzlei.example.de
PORTAL_PUBLIC_URL=https://mandanten.example.de        # Host-Routing /portal
STAFF_COOKIE_DOMAIN=kanzlei.example.de
PORTAL_COOKIE_DOMAIN=mandanten.example.de
SMTP_HOST=mail.example.de                              # exakter Hostname!
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM=TaxTronik <noreply@example.de>
POSTGRES_PASSWORD=...   AUTH_SECRET=...   # + restliche Secrets aus .env.example
```

### Update-Ablauf (Reihenfolge zwingend)

```bash
# 1. Code holen
git fetch origin && git reset --hard origin/main
chmod +x dc                                   # nur falls nötig

# 2. DB-Migrationen ZUERST — bevor das neue Image hochkommt. Sonst fragt
#    der neue Code Spalten/Tabellen ab, die noch fehlen → 500 auf allen
#    betroffenen Seiten. Prisma-CLI direkt aufrufen (umgeht den pnpm-11-
#    Wrapper, der auf dem Server bricht). migrate deploy ist idempotent.
export DATABASE_URL="postgresql://taxtronik:$(grep -E '^POSTGRES_PASSWORD=' .env|cut -d= -f2-)@127.0.0.1:5432/taxtronik?schema=public"
node "$(find node_modules -path '*/prisma/build/index.js' -not -path '*/cache/*'|head -1)" \
  migrate deploy --schema packages/db/prisma/schema.prisma

# 3. Images neu bauen (Build-Context = Repo-Root, KEIN --build-arg).
#    --no-cache, damit Code-Änderungen sicher greifen. Worker mitbauen:
#    packages/evidence + packages/storage laufen auch im Worker.
docker build --no-cache -f infra/docker/Dockerfile.web    -t taxtronik/web:latest    .
docker build --no-cache -f infra/docker/Dockerfile.worker -t taxtronik/worker:latest .

# 4. Container mit neuem Image neu erzeugen
./dc up -d --force-recreate --no-deps app worker

# 5. Verifikation
docker ps --filter name=taxtronik-app --format '{{.Image}} | {{.Status}}'
curl -s http://127.0.0.1:${APP_BIND_PORT:-3001}/api/health
curl -sI https://mandanten.example.de/ | grep -i location   # → /portal/login
```

Weitere `dc`-Befehle: `./dc ps`, `./dc logs app --tail 40`,
`./dc --infra up -d` (nur Postgres/Redis/SeaweedFS/ClamAV), `./dc down`.

**Wichtig:** Ein bloßes `./dc up -d` startet nur den **alten** Container neu —
Code-Änderungen brauchen immer `docker build` (Schritt 3) **plus**
`--force-recreate`. Migration ohne neues Image ist unkritisch (neue Spalten
stören das alte Image nicht); neues Image ohne Migration **nicht**.

Reverse-Proxy + TLS (NGINX + acme.sh o. ä.) stellt die Kanzlei-IT; der
Object-Store ist **nie** öffentlich erreichbar (App proxied Up-/Downloads).
Beispiel-NGINX: [infra/nginx/taxtronik.conf.example](infra/nginx/taxtronik.conf.example).

## Projektstruktur

```
apps/
  web/      Next.js (UI + API + Server Actions)
  worker/   BullMQ-Worker (Virus-Scan, PDF, Hash-Versiegelung, BWA)
packages/
  db/         Prisma-Schema, Migrationen, RLS-Helper
  core/       Domain-Typen, Zod-Schemas, Errors
  auth/       Auth.js-Konfig, RBAC-Policies
  evidence/   Hash-Chain + RFC-3161-Adapter (Manipulationsevidenz)
  storage/    S3-Client, Object-Lock, ClamAV
  jobs/       BullMQ-Queues + Schedules
  pdf/        PDF-Pipeline (react-pdf + Playwright)
  mail/       Nodemailer + react-email-Templates
  importers/  Excel-/CSV-/PDF-Importer für DATEV/Transparenzregister-Daten
  ui/         shadcn/ui-Komponenten + Tailwind-Preset
  config/     ENV-Schema (Zod), Tenant-Settings-Reader
infra/
  compose/    docker-compose.yml + Overrides
  n8n/        Versionierte Workflow-Exports (JSON)
  scripts/    init-storage.sh, postgres-init.sql, etc.
docs/
  architecture.md
  adr/        Architecture Decision Records
  compliance/ GoBD, DSGVO, GwG
```

## Compliance

Diese Software ist für regulatorisch sensible Daten gebaut:

- **§ 203 StGB Steuergeheimnis** — RLS in Postgres + App-Level-Filter, doppelte Verteidigung. Object-Store ist nie öffentlich erreichbar (rein Docker-intern); Up-/Downloads laufen ausschließlich same-origin durch die App — minimale Angriffsfläche statt presigned-direct.
- **GoBD** — Object-Lock-Storage, hash-verkettetes Audit-Log, RFC-3161-Tagesversiegelung, 10-Jahre-Retention.
- **DSGVO** — DE-Hosting, AVV/DPA, Lösch-/Auskunftskonzept (Iter. 7).
- **GwG** — Systemische Schranke (DB-Trigger + App-Guard) verhindert Mandantenanlage ohne verifizierten GwG-Check.
- **eIDAS** — Vollmachten via Signatur-Adapter (MVP: fortgeschrittene Signatur via OTP, QES-Plug-in optional).

Vor Produktivstart **extern Pen-Test** durchführen lassen.

## Verifikation der Manipulationsevidenz

Wirtschaftsprüfer/Revisoren können die Hash-Chain unabhängig nachrechnen:

```bash
pnpm verify:chain
```

Liefert OK bei intakter Kette, sonst Bericht des ersten Bruchs mit Datum/Eintrag-ID.
