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

| Schicht     | Wahl                                                                  |
| ----------- | --------------------------------------------------------------------- |
| Web/App     | Next.js 16 App Router, React 19, TypeScript                           |
| Auth        | Auth.js v5, Mitarbeiter mit Passwort + TOTP, Mandanten mit Magic-Link |
| Datenbank   | Postgres 18, Prisma, Row-Level Security                               |
| Storage     | SeaweedFS S3-API, Object-Lock, ClamAV-Scan vor Commit                 |
| Jobs        | BullMQ Worker, Redis                                                  |
| Workflows   | n8n für Reminder, Kommunikation und Cron-Automation                   |
| Risk / TCMS | optionale on-prem Risk-Layer-Engine (`/v1/*`)                         |
| Deploy      | Docker Compose, On-Premise, Reverse Proxy davor                       |

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

Zusätzliche Retention-/Object-Lock-Fixtures für lokale Abnahmetests:

```bash
pnpm demo:retention
```

Das erzeugt GwG-Testfälle für löschreif/nicht löschreif sowie Object-Lock
abgelaufen/aktiv. Nicht in Produktion ausführen.

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

| Dienst           | URL                     |
| ---------------- | ----------------------- |
| Mailhog          | <http://localhost:8025> |
| n8n              | <http://localhost:5678> |
| SeaweedFS Master | <http://localhost:9333> |
| SeaweedFS Filer  | <http://localhost:8888> |

Optionaler Risk-Layer lokal:

```bash
# App laeuft direkt auf demselben Host:
RISK_LAYER_URL=http://127.0.0.1:8000
RISK_LAYER_TOKEN=<mindestens-32-zeichen>
```

`RISK_LAYER_URL` ist ein Operator-Backend-Ziel und darf Docker-Service-DNS
(`http://risk-layer:8000`), Loopback (`http://127.0.0.1:8000`) oder eine
interne IP enthalten. `INTERNAL_FETCH_HOSTS` wird dafür nicht benötigt; diese
Allowlist bleibt für allgemeine `safeFetch`-Pfade wie n8n, RSS, TSA und
Update-Manifest relevant.

Wichtig bei Docker: `127.0.0.1`/`localhost` wird aus dem App-Container heraus
als App-Container selbst interpretiert, nicht als Host. Im Compose-Stack mit
Risk-Layer-Profil deshalb `RISK_LAYER_URL=http://risk-layer:8000` verwenden.
Bei einer separat auf dem Host laufenden Engine eine interne Adresse nutzen,
die aus dem `taxtronik-app`-Container erreichbar ist.

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

Produktiv läuft der Stack über die Operator-CLI [`./taxtronik`](taxtronik). Sie
wählt immer die richtigen Compose-Dateien, nutzt die Root-`.env` und validiert
sie vorab (`doctor`) statt mitten im Deploy abzubrechen. Die SeaweedFS-S3-
Konfiguration entsteht erst im Container flüchtig unter `/run`; es gibt keine
hostseitige Klartext-Konfigurationskopie mehr.

Erstinstall (eine Kanzlei, ein Server, ein Kommando bis zur laufenden App):

```bash
./taxtronik bootstrap   # Prod-.env + Secrets, Infra, Images, Migration, Tenant + Admin
```

Im Normalfall danach:

```bash
./taxtronik deploy      # bauen/pullen + migrieren + starten + Health-Smoke
./taxtronik update      # git ff-only + Backup + bauen/pullen + migrieren + starten
./taxtronik backup      # manuelles Postgres-Backup nach backups/ + S3-Backup-Bucket
./taxtronik backup-files # Kanzleidateien aus SeaweedFS nach backups/object-store
./taxtronik backup-full # quiesziertes, age-verschlüsseltes und signiertes Full-Backup
./taxtronik backup-verify <dir> [public-key]
./taxtronik backup-decrypt <dir> <leeres-ziel> [age-identity] [public-key]
./taxtronik restore --list
./taxtronik restore --latest --target-url <postgres-url>
./taxtronik restore --file backups/<dump> --target-url <postgres-url>
./taxtronik doctor      # .env prüfen (--fix generiert fehlende Secrets)
./taxtronik rollback    # zurück auf den vorherigen Stand (keine Migration)
```

Releases entstehen über **annotierte**, geschützte SemVer-Tags (`v1.4.0`). Der
Forgejo-Workflow führt für exakt den Tag-Commit im selben Release-DAG die
vollständige CI- und Security-Suite aus; erst danach baut/scant/pusht er Web und
Worker und veröffentlicht verpflichtend das Ed25519-signierte Manifest v2 mit
Commit- sowie beiden Image-Digests. Auf dem Server zeigt
`TAXTRONIK_IMAGE_PREFIX=git.hirschmann-koxha.de/taxtronik` auf die Registry,
`TAXTRONIK_VERSION` auf das Release. Die Operator-CLI verifiziert Manifest,
Tag und Checkout und deployt getrennte
`web:version@sha256:…`-/`worker:version@sha256:…`-Referenzen; auch die OCI-
Revision muss stimmen. Mutable Tags werden nicht als Release-Vertrag
akzeptiert. Details und Rollback-Pfad:
[docs/operations/release.md](docs/operations/release.md)

Bei lokalen Image-Builds (`TAXTRONIK_IMAGE_PREFIX` ohne Registry-Slash) räumt
die Operator-CLI nach erfolgreichem Build ungenutzten Docker-BuildKit-Cache auf
(`until=168h`). Das lässt sich mit `TAXTRONIK_BUILD_CACHE_PRUNE=off` abschalten
oder per `TAXTRONIK_BUILD_CACHE_PRUNE_UNTIL=336h` anpassen. Registry-Deploys
pullen fertige Images und führen keinen Build-Cache-Prune aus.

Backup-Scope: `./taxtronik backup` sichert nur Postgres; `backup-files` erzeugt
nur eine sichtbare Byte-Kopie der SeaweedFS-Buckets. `backup-full` erstellt
dagegen einen zusammenhängenden Wiederanlaufpunkt: Schreibdienste werden
quiesziert, beide DBs sowie Byte-Export gesichert und SeaweedFS-/Redis-/n8n-
Volumes cold gesnapshottet. Die gesamte Nutzlast einschließlich `.env` wird
age-verschlüsselt und durch ein Ed25519-signiertes SHA-256-Inventar versiegelt;
ein getrenntes S3-Offsite-Ziel kann nur mit Versioning + Object Lock COMPLIANCE
verwendet werden. Voraussetzungen und Restore-Drill:
[docs/operations/disaster-recovery.md](docs/operations/disaster-recovery.md).

Der Worker erstellt zusätzlich täglich um 01:00 UTC einen Postgres-Dump und
streamt ihn direkt in den S3-Backup-Bucket. Dieser automatische Lauf erzeugt
keine lokale Air-Gap-Kopie und sichert nicht die SeaweedFS-Dokument-Buckets;
dafür ist regelmäßig `./taxtronik backup-full` beziehungsweise eine getestete
externe SeaweedFS-Replikation erforderlich.

`./taxtronik update` macht bewusst kein `git reset --hard`. Wenn lokale
Änderungen oder ein nicht-fast-forward Stand existieren, bricht das Kommando ab.

Hinweis zum nächsten Update: Durch die Umstellung der Session-Cookie-Namen auf
`__Host-`/`__Secure-`-Präfixe werden einmalig alle aktiven Sessions invalidiert
(Re-Login nötig), und Betreiber mit einer früher kopierten nginx-Config sollten
dort die duplizierten Security-`add_header`-Zeilen entfernen (siehe
`infra/nginx/taxtronik.conf.example` — sonst überschreibt nginx die
token-spezifische `no-referrer`-Referrer-Policy der App).

Wichtige `.env`-Werte für ein Multi-Domain-Deploy:

```ini
NODE_ENV=production
TAXTRONIK_IMAGE_PREFIX=git.hirschmann-koxha.de/taxtronik
TAXTRONIK_VERSION=1.4.0

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

# Optional: n8n-UI/API hinter eigenem Reverse-Proxy
N8N_HOST=n8n.example.de
N8N_WEBHOOK_URL=https://n8n.example.de/
N8N_BIND=127.0.0.1

# Optional: Risk-Layer / TCMS
RISK_LAYER_URL=http://risk-layer:8000
# Alternativ, wenn die App nicht im Container laeuft oder der Host aus dem
# App-Container ueber diese Adresse erreichbar ist:
# RISK_LAYER_URL=http://127.0.0.1:8000
# oder interne IP:
# RISK_LAYER_URL=http://10.10.0.42:8000
RISK_LAYER_TOKEN=...

SMTP_HOST=mail.example.de
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM="TaxTronik <noreply@example.de>"
```

Mailhog ist ausschließlich Teil des lokalen Dev-Stacks. In Produktion müssen
`SMTP_HOST`, `SMTP_PORT` und `SMTP_FROM` auf ein echtes SMTP-Relay zeigen;
`./taxtronik doctor` blockt `mailhog` sowie `localhost:1025`/`127.0.0.1:1025`.

Reverse Proxy und TLS liegen vor der App. Die Compose-Ports sind auf localhost
gebunden; der Object-Store bleibt intern. Das nginx-Beispiel enthält den
Single-Host-Default, Hinweise für `/api/n8n/*`, ein optionales n8n-UI-VHost und
ein Staff-/Portal-Split-Setup:
[infra/nginx/taxtronik.conf.example](infra/nginx/taxtronik.conf.example)

Für getrennte Staff-/Mandanten-Domains:

- `NEXTAUTH_URL` zeigt auf die Staff-/Kanzlei-URL.
- `PORTAL_PUBLIC_URL` zeigt auf die Mandantenportal-URL und wird für
  Mandanten-Magic-Links, PoA- und GwG-Onboarding-Links genutzt.
- `STAFF_COOKIE_DOMAIN` und `PORTAL_COOKIE_DOMAIN` sind Subdomain-spezifisch,
  nie die Parent-Domain.
- n8n ruft App-Endpunkte unter `/api/n8n/*` mit HMAC-Signatur auf; `TAXTRONIK_API_URL`
  in n8n zeigt auf die intern oder per Proxy erreichbare App-Basis-URL.

Details: [docs/operations/subdomain-trennung.md](docs/operations/subdomain-trennung.md)
und [infra/n8n/workflows/README.md](infra/n8n/workflows/README.md).

Weitere Betriebsrunbooks:

- [Day-2 Operations](docs/operations/day-2-operations.md)
- [Secret-Rotation](docs/operations/secret-rotation.md)
- [Release-Rehearsal](docs/operations/release-rehearsal.md)
- [Disaster Recovery](docs/operations/disaster-recovery.md)

Weitere Operator-Kommandos (docker-compose-Passthrough):

```bash
./taxtronik ps
./taxtronik logs app --tail 80
./taxtronik logs worker --tail 80
./taxtronik --infra up -d      # nur Infra (Postgres/Redis/S3/ClamAV)
./taxtronik down
```

## Qualitätssicherung

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:ops
pnpm e2e
pnpm verify:schema-drift
pnpm verify:chain
```

Hinweise:

- `pnpm lint` prüft TypeScript (`@typescript-eslint`), React Hooks
  (`eslint-plugin-react-hooks`), Next.js-Konventionen (`@next/eslint-plugin-next`)
  und domänenspezifische AST-Regeln (RBAC-Guardrails).
- `pnpm test` läuft via Turborepo über alle Workspaces mit Test-Skript —
  neben der Web-App auch die Worker-Jobs (`apps/worker/src/jobs/__tests__`)
  und die Packages (u. a. `tax`, `evidence`, `db`, `crypto`, `http-utils`,
  `rss`, `n8n-shared`), inkl. Auth-Suiten für TOTP, Magic-Link und Lockout.
- `pnpm test:ops` prüft die Operator-CLI-Gates (`doctor`, Prod-SMTP ohne
  Mailhog, Risk-Layer-Paarung, Build-Cache-Prune, Restore-Quellwahl), die
  fail-closed Update-/Backup-Reihenfolge und restriktive Secret-Dateirechte
  ohne echten Deploy.
- E2E-Login-Tests brauchen `E2E_TOTP_SECRET`.
- RLS-Cross-Tenant-Tests skippen lokal ohne DB-URLs, schlagen in CI aber fehl,
  wenn `DATABASE_URL` oder `DATABASE_APP_URL` fehlt.
- `pnpm verify:chain` prüft die Audit-Hash-Chain.
- Der CI-Job `restore` fährt einen echten Backup→Restore-Roundtrip
  (`runner --out-file` → `restore --file`) und prüft Zeilenzahlen sowie die
  Audit-Hash-Chain auf der wiederhergestellten DB. Lokal:
  `DATABASE_URL=… bash scripts/restore-selftest.sh` (siehe
  `docs/operations/disaster-recovery.md`, Abschnitt 7.1).
- Das Assurance-Modell bündelt Threat Model, Known Limits und Release-Gates:
  [docs/assurance/assurance-model.md](docs/assurance/assurance-model.md).

## Projektstruktur

```text
apps/
  web/       Next.js UI, API-Routen, Server Actions, Backup/Restore
  worker/    BullMQ Worker für Reminder, Audit, n8n-Outbox, Backup und Wartung
  e2e/       Playwright-Tests

packages/
  config/      ENV-Schema und zentrale Runtime-Konfiguration
  crypto/      Kryptografie-Helfer
  db/          Prisma-Schema, Migrationen, RLS/Tenant-Kontext
  evidence/    Audit-Hash-Chain, Archive, Verify-CLI
  http-utils/  Safe Fetch, SSRF-Guards, Netzwerk-Utilities
  n8n-shared/  HMAC-Signatur für App/Worker -> n8n
  risk-layer/  Zustandsloser §4-Engine-Client (Risk Analysis)
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
- eIDAS: RFC-3161-Zeitstempel-Adapter; die PoA-Bestätigung per Magic-Link und
  E-Mail-Code wird nicht als fortgeschrittene oder qualifizierte Signatur zugesagt.

Sicherheitslücken vertraulich melden: siehe [SECURITY.md](SECURITY.md).

Vor Produktivstart sollte ein externer Penetrationstest und ein Restore-Test
aus einem echten Backup erfolgen.
