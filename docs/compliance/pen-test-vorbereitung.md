# Pen-Test-Vorbereitung

Checkliste für die Beauftragung eines externen Penetrationstests vor dem
ersten Produktivstart bei einer Kanzlei.

> **Hinweis:** Diese Checkliste ist intern. Sie wird dem Pentester als
> Scope-Dokument übergeben, NICHT als Aussage über den aktuellen Schutzgrad.

---

## 1. Test-Scope

### In Scope

- **Web-App** (`/staff/*`, `/portal/*`, `/poa/sign`, `/gwg-onboarding`)
  - Alle Server-Actions
  - Alle API-Routen unter `/api/staff/*` und `/api/portal/*`
  - n8n-Webhook-Endpoints `/api/n8n/*` (HMAC-Signatur)
  - Magic-Link-Verify, PoA-Sign-Token, GwG-Onboarding-Token
- **Auth-Flow** (Auth.js v5 mit TOTP-Pflicht für Staff, Magic-Link für Portal)
- **Tenant-Isolation** via Postgres-RLS (siehe `packages/db/src/__tests__/rls-cross-tenant.test.ts`)
- **Datei-Upload** (app-proxied, synchroner ClamAV-Scan, SeaweedFS-Object-Lock)
- **Audit-Log-Integrität** (Hash-Chain + RFC-3161-Stempel)

### Out of Scope (separat oder später)

- Reverse-Proxy / TLS-Termination (durch Kanzlei-IT betrieben)
- E-Mail-Server (SMTP-Relay extern)
- ELSTER-ERiC-Sidecar (noch nicht im Stack)
- DDoS-Resistenz (durch Hosting-Provider abgedeckt)

## 2. Environment

- **Staging-Umgebung** mit produktivnaher Konfiguration:
  - Eigene Domain (z. B. `pentest.taxtronik.dev`), kein Production-Tenant
  - Postgres + Redis + SeaweedFS + ClamAV als Service-Container
  - n8n bewusst NICHT konfiguriert (Pentester soll Verhalten ohne Workflows testen)
- **Tenants vorbereitet:**
  - Tenant A „Kanzlei Alpha" mit 5 Mandanten, 3 Mitarbeitern
  - Tenant B „Kanzlei Beta" mit 5 Mandanten, 3 Mitarbeitern
  - **Cross-Tenant-Test-Konten** für beide
- **Test-Daten:** Synthetisch, kein PII echter Personen
- **Logs:** strukturierte Logs (pino) werden nach STDOUT geschrieben, ELK-Stack
  optional

## 3. Bereitgestellte Artefakte

- [ ] Architektur-Diagramm + Datenflüsse
- [ ] Schema-Diagramm (`prisma generate --generator dbml` o. ä.)
- [ ] Liste der Auth-Surfaces + Cookie-Konfig
- [ ] Liste der RLS-Policies (Auszug aus den Migrations-SQL-Dateien)
- [ ] Liste der DB-Trigger (insbesondere `audit_log`-Insert-Only,
      GwG-Schranke, `appeal_deadline`-Auto-Setter)
- [ ] FEATURES.md
- [ ] Test-Account-Zugangsdaten (siehe „Test-Konten" unten)
- [ ] Hinweis auf bekannte Risiken (siehe Abschnitt „Vorbekannte Limits")

## 4. Test-Konten

| Tenant | Rolle | Login | Passwort |
|---|---|---|---|
| Alpha | ADMIN | admin@alpha.test | (bei Übergabe) |
| Alpha | EMPLOYEE | bea@alpha.test | (bei Übergabe) |
| Alpha | Portal-Kontakt | mandant1@alpha-clients.test | (Magic-Link) |
| Beta | ADMIN | admin@beta.test | (bei Übergabe) |
| Beta | EMPLOYEE | klaus@beta.test | (bei Übergabe) |

TOTP-Secrets liegen in einem separaten verschlüsselten Übergabe-Dokument.

## 5. Test-Schwerpunkte

### 5.1 Authentifizierung & Session

- [ ] Brute-Force-Schutz auf Staff-Login (Rate-Limit + Account-Lock)
- [ ] TOTP-Replay-Schutz (gleicher Code zweimal)
- [ ] TOTP-Bypass-Versuche (leere Codes, Codes für anderen User)
- [ ] Magic-Link-Token: Wiederverwendung nach Login? Token-Brute-Force?
      Cross-Tenant-Token verwendbar?
- [ ] Session-Cookie: HttpOnly, Secure (Production), SameSite=Lax,
      Path-Beschränkung (Staff-Cookie nicht für `/portal`-Routes verwendbar)
- [ ] Session-Fixation, CSRF (insbesondere Server-Actions)
- [ ] Logout: Cookie wirklich invalidiert?

### 5.2 Tenant-Isolation (kritisch)

- [ ] Mit Tenant-A-Login auf Resource-IDs aus Tenant B zugreifen
      (alle GET-Endpoints + Server-Actions)
- [ ] Cross-Tenant-Updates via direktem API-Call mit fremden IDs
- [ ] RLS-Bypass-Versuche via Prisma-Bugs / `$queryRaw`-Injection
- [ ] Subdomain-Spoofing falls produktiv genutzt
- [ ] N8n-Webhook ohne HMAC: 401?
- [ ] N8n-Endpunkte mit gültigem HMAC, aber Tenant-A-Daten als Body, Tenant-B-Token

### 5.3 Public-Pfade (Token-basiert)

- [ ] PoA-Sign: Token-Brute-Force-Resistenz, Replay nach Signatur
- [ ] PoA-Sign: OTP-Brute-Force, OTP-Wiederverwendung, Timing-Side-Channel
- [ ] GwG-Onboarding: Token-Brute-Force, Submit nach Submit blockiert
- [ ] GwG-Onboarding-Upload: Datei-Größe-Limit (10 MB) hart durchgesetzt?
- [ ] GwG-Onboarding-Upload: Pfad-Traversal in `fileName`?
- [ ] GwG-Onboarding-Upload: ClamAV-Bypass mit EICAR-Test
- [ ] GwG-Onboarding: Cross-Tenant-Token-Eintauschen?

### 5.4 Datei-Upload

- [ ] Mime-Type-Spoofing
- [ ] Polyglot-Files (PDF mit eingebettetem JS)
- [ ] Zip-Bomb (kleine Datei expandiert auf GB)
- [ ] EICAR — wird vom ClamAV-Container abgelehnt?
      (Presigned-Browser-Uploads und den Quarantäne-Bucket gibt es nicht
      mehr — Uploads laufen app-proxied mit synchronem Scan, der
      Object-Store ist nur intern erreichbar)
- [ ] Object-Lock: GoBD-Klassen (COMPLIANCE) wirklich unlöschbar?
      GwG-Bucket (GOVERNANCE): Frühlöschung nur mit
      `BypassGovernanceRetention`-Recht möglich?

### 5.5 Server-Actions (Next.js 16)

- [ ] Action-Endpoint von außen direkt aufrufen (Form-Action-URL)
- [ ] Action-Argument-Tampering (in der Server-Action `formData` lesen)
- [ ] Action ohne CSRF-Schutz? (Next 16 hat eingebaute Action-Encryption,
      verifizieren!)

### 5.6 Audit-Log + Hash-Chain

- [ ] UPDATE/DELETE auf `audit_log` als App-User → muss DB-Trigger blockieren
- [ ] Manipulation einer Audit-Zeile via direktem SQL und Re-Verifikation
      → CLI `pnpm verify:chain` muss anschlagen
- [ ] Versuch, einen Eintrag rückwirkend einzufügen (mit „älterem"
      `occurred_at`) — Hash-Chain bleibt konsistent, aber das `id`
      ist immer das letzte → erkennbar?

### 5.7 Inhaltliche Schwachstellen

- [ ] XSS in Markdown-Renderern (Wissensartikel, Vollmacht-Scope, GwG-Notizen)
- [ ] XSS in Form-Builder-Optionen (`label`-Feld)
- [ ] SQL-Injection in `$queryRaw`-Aufrufen (z. B. Reports-Page)
- [ ] HTML-Injection in n8n-Mail-Templates
- [ ] HTTP-Header-Injection (Filename in Content-Disposition)
- [ ] Path-Traversal in DATEV-Belege-Export-ZIP-Filenames

### 5.8 Authorization

- [ ] EMPLOYEE-Rolle versucht ADMIN-only-Pfade (`/staff/admin/*`)
- [ ] EMPLOYEE versucht eigene Rolle auf ADMIN zu eskalieren
- [ ] CLIENT_CONTACT versucht Staff-Pfade
- [ ] Mandant A's Kontakt zugreift auf Mandant B's Dokumente

## 6. Vorbekannte Limits

Folgende Schwächen sind dem Team bekannt und werden NICHT durch den Pen-Test
verifiziert (separate Sanierungs-Pipeline):

- Datei-Upload-Limit pro Tenant (Storage-Quota) ist nicht implementiert
- E-Mail-Versand läuft per App-SMTP-Templates; n8n ergänzt Workflows/Reminder
  und ist ohne Setup kein Blocker für transaktionale Basismails
- BWA-Score-Card-Engine ist regelbasiert ohne Profi-Validierung
- Steuer-Engine: NRW-/landesspezifische Termine + Werktagsverschiebung
  vorhanden, aber rechtliche Vollständigkeit nicht zertifiziert

## 7. Reporting-Format

- **CVSS 3.1 Score** pro Finding
- **Reproduktion-Schritte** (cURL / Burp-Proxy-Export bevorzugt)
- **Empfehlung** mit konkretem Code-Pointer wenn möglich
- **Severity-Aufschlüsselung:** Critical / High / Medium / Low / Informational

## 8. Nach dem Test

- [ ] Findings im Repo als GitHub-Issues mit `security`-Label
- [ ] Critical/High in 7 Tagen patchen
- [ ] Re-Test der gefixten Findings
- [ ] Pentest-Bericht im DSGVO-Verarbeitungsverzeichnis archivieren
      (Art. 32 DSGVO-Nachweis)
- [ ] Wirtschaftsprüfer-Übergabe: Bericht + Fix-Liste + Hash-Chain-Stand
