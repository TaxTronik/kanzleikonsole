<p align="center">
  <img src="docs/assets/logo.svg" alt="TaxTronik" width="120" height="120" />
</p>

<h1 align="center">TaxTronik</h1>

<p align="center">Kanzlei- und Mandanten-Dashboard für deutsche Steuerberater. On-Premise pro Kanzlei.</p>

## Überblick

TaxTronik verbindet Kanzlei-Workflows, Mandantenportal, Dokumentenablage,
Compliance und Hintergrund-Jobs in einem lokalen Deploy. Die Software ist auf
steuerliche Berufsgeheimnisse und revisionsnahe Anforderungen ausgelegt:
Postgres-RLS, App-Level-Tenant-Filter, TOTP für Mitarbeiter, Magic-Link für
Mandanten, S3-kompatibler Object-Store ohne öffentliche Direktlinks, ClamAV,
Audit-Hash-Chain und optionale RFC-3161-Zeitstempel.

Vollständige Architektur: [docs/architecture.md](docs/architecture.md)

## Tech-Stack

| Schicht | Wahl |
|---|---|
| Web/App | Next.js 16 App Router, React 19, TypeScript |
| Auth | Auth.js v5, Mitarbeiter mit Passwort + TOTP, Mandanten mit Magic-Link |
| Datenbank | Postgres 18, Prisma, Row-Level Security |
| Storage | SeaweedFS S3-API, Object-Lock, ClamAV-Scan vor Commit |
| Jobs | BullMQ Worker, Redis |
| Workflows | n8n für Reminder, Kommunikation und Cron-Automation |
| Deploy | Docker Compose, On-Premise, Reverse Proxy davor |

## Entwicklung

Voraussetzungen:

- Docker Desktop oder Docker Engine
- Node.js >= 22.13
- Corepack/pnpm 11: `corepack enable`

Einmaliges Setup:

```bash
./scripts/setup.sh
```

Windows PowerShell:

```powershell
.\scripts\setup.ps1
```

Das Setup erzeugt `.env`, generiert Secrets, startet Postgres/Redis/SeaweedFS/
ClamAV/Mailhog/n8n, installiert Pakete, migriert die DB, legt Buckets an und
seedet Demo-Daten.

Danach starten:

```bash
pnpm --filter @taxtronik/web dev
pnpm --filter @taxtronik/worker dev
```

App: <http://localhost:3000/staff/login>

Der Dev-Seed erzeugt `admin@taxtronik.local`; das einmalige Passwort steht in
der Seed-Ausgabe und in `packages/db/.admin-credentials.txt`. Beim ersten Login
wird TOTP eingerichtet. Danach die Credentials-Datei löschen.

Nützliche lokale Dienste:

| Dienst | URL |
|---|---|
| Mailhog | <http://localhost:8025> |
| n8n | <http://localhost:5678> |
| SeaweedFS Master | <http://localhost:9333> |
| SeaweedFS Filer | <http://localhost:8888> |

Reset:

```bash
./scripts/setup.sh --reset
./scripts/setup.sh --skip-seed
```

PowerShell:

```powershell
.\scripts\setup.ps1 -Reset
.\scripts\setup.ps1 -SkipSeed
```

## Produktivbetrieb

Produktiv läuft der Stack über den Compose-Wrapper [dc](dc). Der Wrapper
setzt immer die richtigen Compose-Dateien, nutzt die Root-`.env` und rendert vor
jedem Compose-Aufruf die SeaweedFS-S3-Konfiguration.

Im Normalfall gibt es nur drei Befehle:

```bash
./scripts/deploy.sh   # aktueller Checkout: Infra, Build, Migration, Restart, Health-Smoke
./scripts/update.sh   # git ff-only, Backup, Build, Migration, Restart, Health-Smoke
./scripts/backup.sh   # manuelles Postgres-Backup in den S3-Backup-Bucket
```

`update.sh` macht bewusst kein `git reset --hard`. Wenn lokale Änderungen oder
ein nicht-fast-forward Stand existieren, bricht das Skript ab.

Hinweis zum nächsten Update: Durch die Umstellung der Session-Cookie-Namen auf
`__Host-`/`__Secure-`-Präfixe werden einmalig alle aktiven Sessions invalidiert
(Re-Login nötig), und Betreiber mit einer früher kopierten nginx-Config sollten
dort die duplizierten Security-`add_header`-Zeilen entfernen (siehe
`infra/nginx/taxtronik.conf.example` — sonst überschreibt nginx die
token-spezifische `no-referrer`-Referrer-Policy der App).

Wichtige `.env`-Werte für ein Multi-Domain-Deploy:

```ini
NODE_ENV=production
TAXTRONIK_VERSION=latest

NEXTAUTH_URL=https://kanzlei.example.de
PORTAL_PUBLIC_URL=https://mandanten.example.de
STAFF_COOKIE_DOMAIN=kanzlei.example.de
PORTAL_COOKIE_DOMAIN=mandanten.example.de
NEXTAUTH_TRUST_HOST=true
TRUST_PROXY_REQUIRED=true

POSTGRES_PASSWORD=...
TAXTRONIK_APP_PASSWORD=...
AUTH_SECRET=...
N8N_HMAC_SECRET=...
N8N_ENCRYPTION_KEY=...
S3_SECRET_KEY=...

SMTP_HOST=mail.example.de
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM="TaxTronik <noreply@example.de>"
```

Reverse Proxy und TLS liegen vor der App. Die Compose-Ports sind auf localhost
gebunden; der Object-Store bleibt intern. Beispiel:
[infra/nginx/taxtronik.conf.example](infra/nginx/taxtronik.conf.example)

Weitere Operator-Kommandos:

```bash
./dc ps
./dc logs app --tail 80
./dc logs worker --tail 80
./dc --infra up -d
./dc down
```

## Qualitätssicherung

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e
pnpm verify:schema-drift
pnpm verify:chain
```

Hinweise:

- `pnpm test` läuft via Turborepo über alle Workspaces mit Test-Skript —
  neben der Web-App auch die Worker-Jobs (`apps/worker/src/jobs/__tests__`)
  und die Packages (u. a. `tax`, `evidence`, `db`, `crypto`, `http-utils`,
  `rss`, `n8n-shared`), inkl. Auth-Suiten für TOTP, Magic-Link und Lockout.
- E2E-Login-Tests brauchen `E2E_TOTP_SECRET`.
- RLS-Cross-Tenant-Tests skippen lokal ohne DB-URLs, schlagen in CI aber fehl,
  wenn `DATABASE_URL` oder `DATABASE_APP_URL` fehlt.
- `pnpm verify:chain` prüft die Audit-Hash-Chain.
- Der CI-Job `restore` fährt einen echten Backup→Restore-Roundtrip
  (`runner --out-file` → `restore --file`) und prüft Zeilenzahlen sowie die
  Audit-Hash-Chain auf der wiederhergestellten DB. Lokal:
  `DATABASE_URL=… bash scripts/restore-selftest.sh` (siehe
  `docs/operations/disaster-recovery.md`, Abschnitt 7.1).

## Projektstruktur

```text
apps/
  web/       Next.js UI, API-Routen, Server Actions, Backup/Restore
  worker/    BullMQ Worker für Scan, Reminder, Audit, n8n-Outbox
  e2e/       Playwright-Tests

packages/
  config/      ENV-Schema und zentrale Runtime-Konfiguration
  crypto/      Kryptografie-Helfer
  db/          Prisma-Schema, Migrationen, RLS/Tenant-Kontext
  evidence/    Audit-Hash-Chain, Archive, Verify-CLI
  http-utils/  Safe Fetch, SSRF-Guards, Netzwerk-Utilities
  n8n-shared/  HMAC-Signatur für App/Worker -> n8n
  rss/         RSS-Fetching und Parser
  storage/     S3/SeaweedFS-Client, Retention, Scan-Pipeline
  tax/         Steuertermine und fachliche Rechenlogik

infra/
  compose/  Docker-Compose Basis, Dev- und App-Overrides
  docker/   Dockerfiles für Web und Worker
  n8n/      Versionierte Workflow-Exports
  nginx/    Reverse-Proxy-Beispiel
  scripts/  Postgres-/Storage-Init

docs/
  adr/          Architecture Decision Records
  compliance/   DSGVO, GoBD, GwG, eIDAS
  operations/   Betrieb, Disaster Recovery, Subdomains
```

## Compliance

TaxTronik ist für regulatorisch sensible Kanzleidaten gebaut:

- Berufsgeheimnis / Mandantentrennung: Postgres-RLS plus App-Level-Filter.
- GoBD: Object-Lock, Audit-Hash-Chain, Tagesversiegelung, Retention.
- DSGVO: Lösch-/Auskunftskonzepte, Portal-/Staff-Trennung, minimale
  öffentliche Angriffsfläche.
- GwG: Verifizierungs-Workflows und systemische Schranken.
- eIDAS: Signatur- und Zeitstempel-Adapter.

Vor Produktivstart sollte ein externer Penetrationstest und ein Restore-Test
aus einem echten Backup erfolgen.
