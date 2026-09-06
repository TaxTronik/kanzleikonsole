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
  - n8n-Callback-Endpoints `/api/integrations/n8n/v1/*` (tenantgebundenes
    Bearer-Credential, Key-ID, Scopes und einmalige Request-ID); die
    `/api/n8n/*`-HMAC-Routen nur, wenn der Legacy-Migrationspfad bewusst
    aktiviert wird
  - Magic-Link-Verify, PoA-Sign-Token, GwG-Onboarding-Token
- **Auth-Flow** (Auth.js v5: Staff mit Passwort + TOTP oder optional nur
  attestiertem FIDO2-Sicherheitsschlüssel; nichtleere Modell-AAGUID-Allowlist,
  FIDO MDS `strict`; Portal unverändert per Magic-Link)
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
- [ ] Für den Hardware-Test: freigegebene Modell-AAGUIDs, dokumentierte
      Testschlüssel und kontrollierter MDS-/DNS-/TLS-Egress; keine produktiven
      Credentials oder Geräteseriennummern
- [ ] Liste der RLS-Policies (Auszug aus den Migrations-SQL-Dateien)
- [ ] Liste der DB-Trigger (insbesondere `audit_log`-Insert-Only,
      GwG-Schranke, `appeal_deadline`-Auto-Setter)
- [ ] FEATURES.md
- [ ] Test-Account-Zugangsdaten (siehe „Test-Konten" unten)
- [ ] Hinweis auf bekannte Risiken (siehe Abschnitt „Vorbekannte Limits")

## 4. Test-Konten

| Tenant | Rolle          | Login                       | Anmeldeweg                     |
| ------ | -------------- | --------------------------- | ------------------------------ |
| Alpha  | ADMIN          | admin@alpha.test            | Passwort + TOTP (bei Übergabe) |
| Alpha  | EMPLOYEE       | bea@alpha.test              | Passwort + TOTP (bei Übergabe) |
| Alpha  | EMPLOYEE       | fido@alpha.test             | zwei physische Testschlüssel   |
| Alpha  | Portal-Kontakt | mandant1@alpha-clients.test | Magic-Link                     |
| Beta   | ADMIN          | admin@beta.test             | Passwort + TOTP (bei Übergabe) |
| Beta   | EMPLOYEE       | klaus@beta.test             | Passwort + TOTP (bei Übergabe) |

TOTP-Secrets liegen in einem separaten verschlüsselten Übergabe-Dokument. Die
beiden FIDO2-Testschlüssel des Hardware-only-Kontos werden getrennt übergeben;
mindestens ein weiterer kompatibler Schlüssel ist für Registrierungs-,
Entfernungs- und Mindestzahltests vorzusehen. Alle Testmodelle müssen mit ihrer
geprüften AAGUID in der Deployment-Allowlist stehen. Keine produktiven
Schlüssel oder echten personenbezogenen Credentials verwenden.

## 5. Test-Schwerpunkte

### 5.1 Authentifizierung & Session

- [ ] Brute-Force-Schutz auf Staff-Login (Rate-Limit + Account-Lock)
- [ ] TOTP-Replay-Schutz (gleicher Code zweimal)
- [ ] TOTP-Bypass-Versuche (leere Codes, Codes für anderen User)
- [ ] Hardware-only lässt sich erst ab zwei aktiven geeigneten Schlüsseln
      einschalten und akzeptiert danach weder Passwort, TOTP noch Backup-Code
- [ ] Die Aktivierung verlangt eine frische Assertion eines registrierten
      Schlüssels und zählt das zweite aktive, policykonforme Credential; die
      getrennte Nutzbarkeit beider Schlüssel und manipulierte
      Eignungsmetadaten testen
- [ ] WebAuthn-Policy: User Verification `required`, `cross-platform`,
      `singleDevice`, nicht backed-up; USB/NFC/BLE/Smartcard akzeptiert,
      `internal`/`hybrid`/`cable` sowie Multi-Device-Credentials abgelehnt
- [ ] Enrollment fordert `attestation: direct` und akzeptiert nur vollständige
      `packed`-Attestation mit Zertifikatskette, freigegebener AAGUID und einem
      im Modus `strict` verifizierten FIDO-MDS-Statement (`basic_full`,
      Hardware/Secure Element, extern, nicht Software/Remote/Plattform)
- [ ] Fehlende, kritische, falsch codierte oder von den Authenticator-Daten
      abweichende Zertifikat-AAGUID wird abgewiesen; übergroße
      Registrierungsantworten, Attestation-Objekte, Zertifikate und x5c-Ketten
      werden vor Netz-/Dependency-Aufrufen gestoppt, eine hängende Prüfung nach
      30 Sekunden abgebrochen
- [ ] Ungültige Trust Anchor, CA-BasicConstraints/KeyUsage/Pfadlänge und
      unbekannte kritische Constraints werden vor jedem CRL-Abruf abgewiesen;
      manipulierte, falsch ausgestellte, veraltete oder zu große CRLs,
      unzulässige URL-Schemata/Ports/Zugangsdaten und Redirects blockieren
      fail-closed
- [ ] Mehrere CRL Distribution Points/General Names, Reason-/Issuer-Scope,
      Zertifikat-seitige `freshestCRL`-Verweise, Delta-CRL,
      `issuingDistributionPoint`, `freshestCRL` und unbekannte kritische
      CRL-Extensions blockieren vor einer partiellen Negativauskunft;
      unterschiedliche Signaturalgorithmen von Issuer-Zertifikat und gültiger
      CRL bleiben interoperabel
- [ ] Leere oder geänderte Allowlist, unbekannte/entfernte AAGUID,
      kompromittierter MDS-Status sowie MDS-/DNS-/TLS-/Egress-Ausfall blockieren
      Enrollment und jede Hardware-Assertion fail-closed; nach Wiederherstellung
      wird ein neuer Readiness-Versuch ausgeführt
- [ ] Der Produktionsstart bindet die Hardware-Policy ausschließlich an die
      Datenbank und benötigt keinen MDS-/CRL-Netzzugriff; ein MDS-Ausfall beim
      Start blockiert nicht den Passwort-/TOTP- oder Portalpfad
- [ ] Ein MDS-Snapshot wird nach höchstens einer Stunde beziehungsweise zum
      früheren `nextUpdate` erneuert; eine kleinere als die clusterweit
      persistierte BLOB-Seriennummer wird nach Prozessneustart und parallel auf
      mehreren App-Instanzen abgewiesen
- [ ] Die signierte Seriennummer eines kryptografisch gültigen neueren BLOBs
      wird vor der lokalen Allowlist-/Modellfilterung zentral übernommen; auch
      wenn danach kein Modell nutzbar ist, bleibt die neue Serie verankert und
      ältere Replicas können nicht weiter committen
- [ ] Ein neuerer MDS-Stand zwischen Trust-Prüfung und Mutation lässt den alten
      Login-/Registrierungs-/Modus-/Recovery-Commit scheitern; der App-Guard
      hält BLOB-Serie, Policy-Revision und Policy-Hash exakt bis
      Transaktionsende, ohne Tabellenrechte zu erhalten; alle Pfade halten die
      Lock-Reihenfolge `MDS -> Staff` ein
- [ ] Rolling Deployments verwenden auf stabilen Replicas dieselbe
      `WEBAUTHN_HARDWARE_POLICY_REVISION` und denselben Hash. Eine höhere
      Revision verdrängt alte Replicas; dieselbe Revision mit abweichendem Hash
      sowie eine niedrigere Revision werden fail-closed abgewiesen
- [ ] Eine leere Allowlist mit höherer Policy-Revision bindet den global
      deaktivierten Zustand und verhindert auch Commits älterer Replicas
- [ ] Challenge ist kurzlebig, zweck-, RP-ID- und Origin-gebunden und nur
      einmal konsumierbar; Replay, falscher User Handle, Credential-ID eines
      anderen Tenants und parallele Signaturzähler-Updates werden abgelehnt
- [ ] Moduswechsel widerruft bestehende Staff-Sitzungen. Verlust-Recovery folgt
      ADMIN → PARTNER/EMPLOYEE beziehungsweise PARTNER → EMPLOYEE, sperrt alle
      Schlüssel und erzwingt neues Passwort/TOTP-Onboarding; ADMIN-Recovery nur
      über die CLI
- [ ] Web-Recovery verlangt im Passwortmodus das aktuelle Actor-Passwort und
      einen frischen echten TOTP; Backup-Code und bereits konsumierter TOTP
      werden abgelehnt. Ein Hardware-only-Actor bestätigt mit seinem eigenen
      Schlüssel; die Challenge ist an Purpose, Tenant, Actor, Zielkonto und
      Actor-Auth-Revision gebunden
- [ ] Parallel geänderte Actor-Revision, Active-/Rollen-/Zielzustände brechen
      Recovery nach frischer Prüfung unter deterministischen Actor-/Target-
      Locks ab; Credential-Widerruf, Zielmutation und Audit hinterlassen keine
      Teiländerung
- [ ] Standard-Passwort-/TOTP-Resets prüfen die erwartete Actor-`authRevision`
      unter den DB-Locks und widerrufen auch aktive Hardware-Credentials, die
      das Zielkonto nur vorab im Passwortmodus registriert hatte; eine eigene
      Passwortänderung widerruft die eigenen aktiven Vorabregistrierungen
- [ ] Kein Staff-Akteur kann eine ADMIN-Rolle entziehen; eine PARTNER-Rolle
      kann nur ein aktiver ADMIN desselben Tenants entziehen. Direkte DB- und
      parallele Rollenänderungen umgehen diesen Recovery-Rollenboden nicht
- [ ] ADMIN-Owner-CLI überschreibt weder Datei noch Symlink, schreibt die
      Credential-Datei mit `O_EXCL` und No-follow-Schutz (POSIX `0600`) vor dem
      Commit und gibt das Klartextpasswort weder auf `stdout`/`stderr` noch in
      Logs aus. Bei Ausgabefehlern wird nur die eigene Teildatei entfernt und
      Reset samt Audit zurückgerollt; Datei und POSIX-Elternverzeichnis werden
      synchronisiert. Ein erst beim DB-Commit erzeugter Fehler darf als
      bekannte Grenze eine sicher geschriebene, aber unwirksame Datei
      zurücklassen
- [ ] Magic-Link-Token: Wiederverwendung nach Login? Token-Brute-Force?
      Cross-Tenant-Token verwendbar?
- [ ] Session-Cookie: HttpOnly, Secure (Production), SameSite=Lax, `Path=/`;
      getrennte Namen/Auth-Konfigurationen verhindern Cross-Surface-Nutzung.
      Bei konfigurierten Staff-/Portal-Subdomains zusätzlich Domain-Scope testen
- [ ] Session-Fixation, CSRF (insbesondere Server-Actions)
- [ ] Logout: Cookie wirklich invalidiert?

### 5.2 Tenant-Isolation (kritisch)

- [ ] Mit Tenant-A-Login auf Resource-IDs aus Tenant B zugreifen
      (alle GET-Endpoints + Server-Actions)
- [ ] Cross-Tenant-Updates via direktem API-Call mit fremden IDs
- [ ] RLS-Bypass-Versuche via Prisma-Bugs / `$queryRaw`-Injection
- [ ] Subdomain-Spoofing falls produktiv genutzt
- [ ] n8n-v1-Callback ohne/falsches Bearer-Credential oder Key-ID: 401?
- [ ] n8n-v1-Callback ohne Scope: 403; ohne/ungültige Request-ID: 400?
- [ ] Replay derselben Request-ID sowie Cross-Tenant-IDOR mit gültigem
      Tenant-A-Credential gegen Tenant-B-Ressourcen werden abgelehnt?
- [ ] Nur bei aktiviertem Legacy-Pfad: `/api/n8n/*` ohne/falsche HMAC,
      abgelaufener Timestamp und wiederverwendete Nonce werden abgelehnt?

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
- Die direkte vollständige `packed`-Attestation samt Allowlist und FIDO MDS
  `strict` ordnet ein Credential einer freigegebenen Modellfamilie zu. Die
  AAGUID ist keine Seriennummer; auch zwei Credentials beweisen nicht
  kryptografisch zwei unterschiedliche physische Geräte. Bei der Aktivierung
  wird nur ein Schlüssel frisch bestätigt, der zweite als aktives,
  policykonformes Credential gezählt. Attachment und Transporte bleiben
  Clientangaben
- MDS-Snapshot und BLOB bleiben prozesslokal und werden spätestens stündlich
  beziehungsweise zum früheren `nextUpdate` bedarfsgetrieben erneuert. Die
  höchste kryptografisch verifizierte BLOB-Seriennummer wird vor dem lokalen
  Modellfilter clusterweit übernommen. Zusätzlich werden Policy-Revision und
  kanonischer Hash zentral gebunden; eine schmale Definer-Funktion bindet das
  exakte Tripel bis zum Commit. Ein Rolling Deploy mit falsch koordinierter
  Revision oder gleichem Revisionswert bei anderem Hash sperrt Hardware-
  Commits fail-closed. Ein eigener periodischer Refresh-Job,
  persistenter Offline-Cache und eine MDS-Statusseite fehlen. Nur eine einzelne
  unpartitionierte Voll-CRL-URI wird unterstützt; andere Scope-/Delta-Formen
  blockieren fail-closed. CRL-Caches gelten bis zum jeweiligen signierten
  `nextUpdate`. Ausfälle oder inkompatible Hersteller-CRLs können
  Hardware-only-Konten bis zur Wiederherstellung oder zum hierarchischen
  Recovery aussperren

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
