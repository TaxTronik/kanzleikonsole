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

Aktueller Softwarestand: **0.2.0**. Die zugehörigen Änderungen stehen im
[Changelog](CHANGELOG.md#020---2026-08-21).

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
| Risk / TCMS | optionales on-prem Signal (`/v1/*`, historische `RISK_LAYER_*`-Namen) |
| Deploy      | Docker Compose, On-Premise, Reverse Proxy davor                       |

## Entwicklung

Voraussetzungen:

- Docker Desktop oder Docker Engine
- Node.js 24 LTS (`>=24.11.0 <25`)
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

Optionales Signal lokal/nativ:

```powershell
.\scripts\win\Start-SignalDev.ps1
```

Der Dev-Starter erwartet den Signal-Checkout standardmäßig als
Nachbarverzeichnis `..\signal`, ergänzt die lokale `.env` um getrennte Bearer-
und Operator-Tokens und startet Engine sowie LLM. Beim ersten Lauf installiert
er außerdem den hash-gepinnten Python-3.12-CPU-Stack für Embeddings. Danach ist
unter **Administration → Integrationen → Signal-Embedding** der Index-Build
verfügbar; BGE-M3 lädt beim ersten Build etwa 2,3 GB. Reine CPU-Ausführung ist
voll funktionsfähig, aber bei Embedding-Build und LLM-Inferenz ein deutlicher
Performance-Bottleneck. Hat der Starter Tokens ergänzt, müssen bereits laufende
Web- und Worker-Prozesse einmal neu gestartet werden.

Ein anderer Checkout kann explizit angegeben werden:

```powershell
.\scripts\win\Start-SignalDev.ps1 -SignalRoot C:\src\signal
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

Im Produktions-Deploy entscheidet `SIGNAL_DEPLOYMENT` über die Verantwortung:
`managed` lässt TaxTronik ein CPU-Komplett-Image einschließlich der
hash-gepinnten Quantenlos-Runtime entweder aus dem gewählten Signal-Git-Stand
lokal bauen oder versioniert aus einer Registry beziehen. Zusätzlich werden
das revisions-/SHA-256-gepinnte Granite-4.1-8B-GGUF und eine gepinnte
`llama-server`-CPU-Engine einmalig provisioniert und read-only eingebunden.
Damit ist die KI-Vertiefung auch ohne GPU vollständig verfügbar; CPU-Inferenz
bleibt allerdings ein klar ausgewiesener Performance-Bottleneck und kann
mehrere Minuten dauern;
`external` bindet eine native/GPU- oder anderweitig betriebene Signal-Instanz
ausschließlich per API an. Im externen Modus führt TaxTronik garantiert keinen
Pull, Start, Stop oder Update für Signal aus.

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

`deploy` ist der einzige Hauptweg — sowohl für die Erstinstallation als auch
für spätere Deployments:

```bash
./taxtronik deploy      # bei Bedarf konfigurieren, bestätigen und vollständig installieren
# optional getrennt: ./taxtronik config && ./taxtronik deploy
```

Der Assistent bietet eine gesunde Standardmethode für bestehende Server mit
vorhandenem Reverse-Proxy und einen bewusst streng gesperrten 1-Klick-Weg mit
Traefik/Let's Encrypt für **komplett leere** Linux-/Docker-Maschinen. Er fragt
Bezugsweg, Domains, Admin/Kanzlei, SMTP und Signal ab, zeigt vor jeder Änderung
eine Zusammenfassung und verlangt eine wörtliche Bestätigung. Auf Debian/Ubuntu
installiert der bestätigte 1-Klick-Weg fehlende Basispakete, Docker/Compose und
die gepinnte Node-/pnpm-Laufzeit selbst. Details und Voraussetzungen:
[Erstinstallation](docs/operations/initial-deploy.md).

`bootstrap` bleibt nur als veralteter Kompatibilitätsalias für `deploy` erhalten.
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

Mutierende Restores haben bewusst keinen impliziten `DATABASE_URL`-Fallback.
Ein In-place-Produktionsrestore ist nur über den expliziten
`--production-target`-Pfad im DR-Runbook möglich; dieser stoppt App, Worker und
n8n und lässt sie bis zur Prüfung des über `--release-version` gebundenen
Release-Vertrags gestoppt.

### Builds über Forgejo CI

Der Forgejo-Workflow [`Build Images`](.forgejo/workflows/build-images.yml)
baut Web- und Worker-Image bei build-relevanten Pushes auf `main`, bei Pull
Requests sowie bei manuellem Start. Diese Läufe sind reine, frühzeitige
Build-Prüfungen: Sie benötigen keine Registry-Zugangsdaten und veröffentlichen
keine Images.

Verwendbare Produktions-Images entstehen über **annotierte**, geschützte
SemVer-Tags (für diesen Stand `v0.2.0`). Der Workflow
[`Release Images`](.forgejo/workflows/release.yml) führt für exakt den
Tag-Commit im selben Release-DAG die vollständige CI- und Security-Suite aus;
erst danach baut, scannt und testet er Web und Worker, lädt die
CycloneDX-SBOMs als CI-Artefakt hoch und veröffentlicht die Images in der
Forgejo-Registry. Abschließend publiziert er das verpflichtende,
Ed25519-signierte Manifest v2 mit Commit- sowie beiden Image-Digests. Auf dem
Server zeigt
`TAXTRONIK_DEPLOY_CHANNEL=release` zusammen mit
`TAXTRONIK_IMAGE_PREFIX=git.hirschmann-koxha.de/taxtronik` auf die Registry,
`TAXTRONIK_VERSION` auf das Release. Die Operator-CLI verifiziert Manifest,
Tag und Checkout und deployt getrennte
`web:version@sha256:…`-/`worker:version@sha256:…`-Referenzen; auch die OCI-
Revision muss stimmen. Mutable Tags werden nicht als Release-Vertrag
akzeptiert. Details und Rollback-Pfad:
[docs/operations/release.md](docs/operations/release.md)

Im Source-Kanal (`TAXTRONIK_DEPLOY_CHANNEL=source`) wird die Version automatisch
als `source-<Git-Commit>` geführt; eine SemVer-Eingabe gibt es dort nicht. Nach
erfolgreichen lokalen Builds räumt die Operator-CLI ungenutzten Docker-BuildKit-Cache auf
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
TAXTRONIK_VERSION=0.2.0

NEXTAUTH_URL=https://kanzlei.example.de
PORTAL_PUBLIC_URL=https://mandanten.example.de
STAFF_COOKIE_DOMAIN=kanzlei.example.de
PORTAL_COOKIE_DOMAIN=mandanten.example.de
NEXTAUTH_TRUST_HOST=true
TRUST_PROXY_REQUIRED=true

POSTGRES_PASSWORD=...
TAXTRONIK_APP_PASSWORD=...
AUTH_SECRET=...
N8N_ENCRYPTION_KEY=...
S3_SECRET_KEY=...

# Ausschließlich für die befristete Migration alter /api/n8n/*-Callbacks:
N8N_LEGACY_CALLBACKS_ENABLED=false
# N8N_HMAC_SECRET=... # bei Callback-Flag oder Outbound-Legacy-URL Pflicht, >= 32 Zeichen

# Produktion: n8n-UI/API immer unter einer eigenen Domain
N8N_HOST=n8n.example.de
N8N_WEBHOOK_URL=https://n8n.example.de/
N8N_PROXY_HOPS=1
N8N_BIND=127.0.0.1
# Nur für Migration bestehender Installationen; neue Routen werden pro
# Workflow in Administration → Einstellungen → n8n-Automatisierung gepflegt:
# N8N_WEBHOOK_BASE_URL=http://n8n:5678/webhook

# Optional: Signal / TCMS. Der interaktive Deploy fragt Modus und Bezugsweg ab.
# managed + source: TaxTronik aktualisiert den Signal-Checkout und baut lokal.
SIGNAL_DEPLOYMENT=managed
SIGNAL_DEPLOY_CHANNEL=source
SIGNAL_GIT_URL=https://git.hirschmann-koxha.de/TaxTronik/signal.git
SIGNAL_GIT_REF=main
SIGNAL_GIT_DIR=/opt/signal
# Alternativ ein bereits veröffentlichtes Image beziehen:
# SIGNAL_DEPLOY_CHANNEL=image
# SIGNAL_IMAGE=git.hirschmann-koxha.de/taxtronik/risk-layer-engine:<signal-release>
RISK_LAYER_URL=http://risk-layer:8000
# Bearer- und Operator-Token werden im managed-Modus getrennt generiert.
RISK_LAYER_TOKEN=...
RISK_LAYER_OPERATOR_TOKEN=...

# Alternativ: native/GPU-Installation oder anderweitig betriebenes Signal.
# TaxTronik nutzt dann nur die API und führt niemals Signal-Updates aus:
# SIGNAL_DEPLOYMENT=external
# SIGNAL_IMAGE=
# RISK_LAYER_URL=http://10.10.0.42:8000

SMTP_HOST=mail.example.de
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM="TaxTronik <noreply@example.de>"
```

Mailhog ist ausschließlich Teil des lokalen Dev-Stacks. In Produktion müssen
`SMTP_HOST`, `SMTP_PORT` und `SMTP_FROM` auf ein echtes SMTP-Relay zeigen;
`./taxtronik doctor` blockt `mailhog` sowie `localhost:1025`/`127.0.0.1:1025`.

### n8n-Integration

TaxTronik trennt die n8n-Instanz von den eigentlichen Workflow-Zielen:
Instanz-UI, Management-API (`/api/v1`), Webhook-Präfix
(`/webhook`) und exakte Production-Webhook-URL eines veröffentlichten
Workflows sind verschiedene Adressen. Neue und eigene Workflows werden unter
**Administration → Einstellungen → n8n-Automatisierung** mit ihrer exakten
Production-URL registriert und abonnieren nur die benötigten Events. Mehrere
Ziele pro Event werden unabhängig zugestellt. Neue oder geänderte Ziele
bleiben zunächst deaktivierte Entwürfe: erst synthetisch testen, dann
unverändert in einem zweiten Speichervorgang aktivieren.

`N8N_WEBHOOK_URL` bestimmt die von n8n angezeigte externe
Webhook-Basis. `N8N_WEBHOOK_BASE_URL` ist dagegen nur der
TaxTronik-Legacy-Fallback `<basis>/<event>` und soll bei neuen
Installationen leer bleiben; der Production-Compose-Default ist deshalb leer.
Wird er für eine Bestandsmigration gesetzt, ist wie beim Legacy-Callback-Flag
ein mindestens 32 Zeichen langes `N8N_HMAC_SECRET` Pflicht. Der Wert ersetzt
keine konkreten Workflow-Ziele.
Test-URLs mit `/webhook-test/` sind nicht produktionsfähig; der
Workflow muss in n8n veröffentlicht sein.

Für die Gegenrichtung erzeugt der Assistent ein separates, tenantgebundenes
Callback-Credential aus Key-ID, einmal angezeigtem Bearer-Token und minimalen
Scopes. Neue Workflows rufen damit ausschließlich
`/api/integrations/n8n/v1/*` auf. Der n8n-Management-API-Key und
das pro Tenant gespeicherte Outbound-HMAC-Secret sind davon unabhängige
Zugangsdaten. Die globalen Legacy-Callbacks `/api/n8n/*` liefern standardmäßig
vor jeder Authentifizierung `404`. Nur für eine befristete Bestandsmigration
werden sie mit `N8N_LEGACY_CALLBACKS_ENABLED=true` und einem mindestens
32 Zeichen langen `N8N_HMAC_SECRET` freigeschaltet. Beim
Workflow-Import materialisiert TaxTronik App-Basis, Key-ID und
Mail-Nicht-Geheimnisse interaktiv; Bearer-, HMAC- und SMTP-Secrets bleiben
n8n-Credentials. Die App-Basis wird getrennt als **TaxTronik-Adresse aus
n8n** gespeichert (`BUNDLED`: in Produktion `http://app:3000`, im lokalen
Dev-Stack `http://host.docker.internal:3000`; extern: eine aus der
n8n-Laufzeit erreichbare öffentliche Adresse). Die Vorlagen benötigen weder
`$env` noch die
editionsabhängigen `$vars` und sind mit n8n Community kompatibel.

Geführtes Setup, eigene Workflows, Eventkatalog und Datenschutz:
[n8n-Automatisierungen](docs/anwenderdoku/n8n-automatisierungen.md).
Betrieb und Fehlerdiagnose:
[Day-2 Operations](docs/operations/day-2-operations.md#n8n).

Reverse Proxy und TLS liegen vor der App. Die Compose-Ports sind auf localhost
gebunden; der Object-Store bleibt intern. Das nginx-Beispiel enthält den
Single-Host-Default, Hinweise für `/api/integrations/n8n/v1/*` und
Legacy-`/api/n8n/*`, den eigenen n8n-UI-VHost und
ein Staff-/Portal-Split-Setup:
[infra/nginx/taxtronik.conf.example](infra/nginx/taxtronik.conf.example)

Für getrennte Staff-/Mandanten-Domains:

- `NEXTAUTH_URL` zeigt auf die Staff-/Kanzlei-URL.
- `PORTAL_PUBLIC_URL` zeigt auf die Mandantenportal-URL und wird für
  Mandanten-Magic-Links, PoA- und GwG-Onboarding-Links genutzt.
- `STAFF_COOKIE_DOMAIN` und `PORTAL_COOKIE_DOMAIN` sind Subdomain-spezifisch,
  nie die Parent-Domain.
- n8n ruft neue App-Endpunkte unter `/api/integrations/n8n/v1/*` mit
  tenantgebundenem, scoped Callback-Credential auf; TaxTronik materialisiert
  die intern oder per Proxy erreichbare App-Basis beim Import in die
  ausgewählten Vorlagen.

Details: [docs/operations/subdomain-trennung.md](docs/operations/subdomain-trennung.md),
[n8n-Anwenderdokumentation](docs/anwenderdoku/n8n-automatisierungen.md) und
[infra/n8n/workflows/README.md](infra/n8n/workflows/README.md).

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
  mail/        Template-Mail-Versand (SMTP, Dispatch, Safe-Markdown) für Web + Worker
  n8n-shared/  Eventkatalog, HMAC-Signatur und Outbox-Enqueue-Kern für App/Worker -> n8n
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

## Lizenz

Der Projektquellcode steht unter der GNU Affero General Public License,
Version 3. Der vollständige Lizenztext liegt in [LICENSE](LICENSE).
