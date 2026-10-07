# TaxTronik Threat Model

> **Leitsatz:** Keine Kontrollbehauptung ohne Gegenbeweis. Kein Release ohne bestandene Vertrauensprüfung.

## 1. Kronjuwelen (Crown Jewels)

Die Assets, deren Vertraulichkeit, Integrität oder Verfügbarkeit existenzbedrohend wären, wenn kompromittiert:

| Asset                | Schutzziel                  | Begründung                                                      |
| -------------------- | --------------------------- | --------------------------------------------------------------- |
| **Mandantendaten**   | Vertraulichkeit             | §203 StGB, §62 StBerG — Berufsverschwiegenheit                  |
| **Tenant-Isolation** | Vertraulichkeit             | Mandant A darf NIEMALS Daten von Mandant B sehen                |
| **GwG-Daten**        | Integrität, Vertraulichkeit | §§ 8, 10–12 GwG — Identifizierung, Verifizierung, Aufbewahrung  |
| **Audit-Chain**      | Integrität, Verfügbarkeit   | § 146 Abs. 4 AO / GoBD — Nachvollziehbarkeit, Unveränderbarkeit |
| **Evidence Packs**   | Integrität                  | Hash-Chain + RFC 3161 TSA — kryptographischer Beweis            |
| **Rollen/Rechte**    | Integrität                  | RBAC — Admin ist nicht Gott, Principle of Least Privilege       |
| **Exportpfade**      | Vertraulichkeit             | GoBD-Export, DATEV, XRechnung — keine Restricted-Daten-Lecks    |
| **Portalzugänge**    | Vertraulichkeit, Integrität | Magic-Link-Auth, Mandanten-Self-Service                         |
| **Admin-Funktionen** | Integrität                  | DSGVO-Anonymisierung, Audit-Archivierung, Backups               |

## 2. Bedrohungen (Threats) — "Was muss niemals passieren"

### 2.1 Mandantentrennung (§203 StGB)

| ID      | Was muss niemals passieren                                                                       | Schicht                                                                             | Test                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| T-ISO-1 | Ein User sieht Daten eines anderen Tenants                                                       | RLS + App-Filter                                                                    | `rls-cross-tenant.test.ts`, E2E 07 (5.1-5.4), `verify:rls`                                  |
| T-ISO-2 | Eine Server Action umgeht Object Gates                                                           | `staffActionGuard` / `portalActionGuard`                                            | `server-action-authz.test.ts` (AST-Guard)                                                   |
| T-ISO-3 | Eine Query ohne `withTenantContext` läuft gegen Mandantendaten                                   | PrismaClient-Guard                                                                  | `prisma-client-guard.test.ts` (AST-Guard)                                                   |
| T-ISO-4 | Eine neue Tabelle ohne RLS wird hinzugefügt                                                      | FORCE RLS + Drift-Gate                                                              | `verify:rls` in CI                                                                          |
| T-ISO-5 | Ein Worker-Job, n8n-Callback oder der iCal-Feed liest oder schreibt Mandantendaten am RLS vorbei | App-Rolle im SYSTEM-Kontext (`withSystemContext`), Owner nur auf begründeten Pfaden | App-Rollen-Suiten `*-db.test.ts` mit gesperrtem Owner-Client, `prisma-client-guard.test.ts` |

### 2.2 Audit-Chain / GoBD

| ID      | Was muss niemals passieren                                | Schicht                                    | Test                                                                                              |
| ------- | --------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| T-AUD-1 | Eine audit-pflichtige Mutation erzeugt kein Audit-Event   | transaktionales `evidenceService.record`   | Modulspezifische Action-Tests; kein vollständiger globaler AST-Nachweis                           |
| T-AUD-2 | Die Hash-Chain ist inkonsistent (Manipulation erkannt)    | SHA-256 + RFC 3161                         | `verify:chain` CLI, `service-verifychain.test.ts`, `canonical-json.property.test.ts`              |
| T-AUD-3 | Ein Audit-Eintrag wird nachträglich geändert              | `prevent_modification()` Trigger           | `rls-cross-tenant.test.ts`                                                                        |
| T-AUD-4 | Ein Quantenlos-Nachweis passt nicht zum gebundenen Rahmen | Commitment + gespeicherter Nachweis/Rahmen | `packages/risk-layer/src/__tests__/los.test.ts`, `apps/web/src/server/risk/__tests__/los.test.ts` |

### 2.3 Authentifizierung & Berechtigungen

| ID       | Was muss niemals passieren                                                                          | Schicht                                                                            | Test                                                     |
| -------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| T-AUTH-1 | Ein nicht-eingeloggter User erreicht eine geschützte Action                                         | `staffActionGuard` / Session-Cookie                                                | `server-action-authz.test.ts`, E2E 09                    |
| T-AUTH-2 | Ein Nicht-Admin führt Admin-Aktionen aus                                                            | `decideStaffGuard`                                                                 | `staff-action-policy.property.test.ts`, E2E 07 (11.2)    |
| T-AUTH-3 | Eine Session bleibt nach Logout aktiv                                                               | Cookie-Clearing, Revocation                                                        | E2E 07 (6.2), `revocation.ts`                            |
| T-AUTH-4 | Der für das Staff-Konto gewählte Anmeldemodus wird umgangen                                         | Provider + Modus-/Revisionsbindung                                                 | `staff.ts`, `webauthn.test.ts`, Login-/Action-Tests      |
| T-AUTH-5 | Ein ungeeigneter/replayed WebAuthn-Schlüssel wird akzeptiert                                        | RP/Origin/Challenge/UV/Key-Policy                                                  | `webauthn.test.ts`, `staff-webauthn-rls.test.ts`         |
| T-AUTH-6 | Attestation löst untrusted/partiellen CRL-Zugriff oder Cache-Poisoning aus                          | Chain-first, vollständige CRL-Scope-Policy, Signatur/Issuer, URL- und Cachegrenzen | `simplewebauthn-crl-hardening.test.ts`                   |
| T-AUTH-7 | Rollenrennen umgeht Recovery-Hierarchie oder ein ruhender Schlüssel überlebt einen Sicherheitsreset | DB-Rollenboden, Actor-`authRevision`, Staff-Locks und Credential-Widerruf          | Admin-/Profil-Action-Tests, `staff-webauthn-rls.test.ts` |
| T-AUTH-8 | Die Owner-CLI legt ein Recovery-Passwort im Terminal, Log oder in einer fremden Datei offen         | Exklusive No-follow-Datei, gezieltes Partial-Cleanup, Datei-/Verzeichnis-`fsync`   | `admin-break-glass.test.ts`                              |

### 2.4 Daten-Integrität

| ID       | Was muss niemals passieren                                   | Schicht                            | Test                                                                   |
| -------- | ------------------------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------- |
| T-DATA-1 | Ein finalisiertes/archiviertes Objekt wird still mutiert     | Trigger, Status Machines           | `invoice-festschreibung.test.ts`, `document_version_immutable_protect` |
| T-DATA-2 | Ein Export enthält Restricted/Confidential ohne Berechtigung | Export-Gates                       | E2E 07 (1.5, 5.3), `access-policy.property.test.ts`                    |
| T-DATA-3 | Parallele Mutation erzeugt Duplikate oder 500er              | Advisory Locks, Unique Constraints | `10-concurrency.spec.ts`                                               |

### 2.5 Infrastruktur

| ID        | Was muss niemals passieren                                                         | Schicht                                                                                                                              | Test                                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-INFRA-1 | Ein Secret wird committet                                                          | gitleaks (CI)                                                                                                                        | `security.yml` (gitleaks scan)                                                                                                                                        |
| T-INFRA-2 | Eine bekannte Vulnerability (high+) in Prod-Dependencies                           | `pnpm audit`                                                                                                                         | `security.yml` (täglich + PR); blockierend ist `--prod --audit-level high`, ein nicht-blockierender Vollauf erfasst zusätzlich Dev-Dependencies und alle Schweregrade |
| T-INFRA-3 | CI-Images oder Actions sind nicht gepinnt                                          | SHA/Digest-Pinning                                                                                                                   | `check-ci-images-pinned.sh`, `check-ci-actions-pinned.sh`                                                                                                             |
| T-INFRA-4 | Allgemeine Server-Fetches erreichen interne/private Ziele                          | `safeFetch`, DNS-Rebinding-Schutz, Allowlist                                                                                         | `@taxtronik/http-utils` Tests                                                                                                                                         |
| T-INFRA-5 | Risk-Layer-Konfiguration ist halb gesetzt oder nutzt ein falsches Vertrauensmodell | `doctor`, dedizierter trusted Risk-Layer-Client                                                                                      | `pnpm test:ops`, Risk-Layer Client Tests                                                                                                                              |
| T-INFRA-6 | n8n-Callbacks werden gefälscht, tenantübergreifend genutzt oder replayed           | v1: tenantgebundenes Bearer-Credential, Key-ID, Scopes, einmalige Request-ID im fail-closed Redis-Store; Legacy-HMAC nur default-off | `callback-auth.test.ts`, `legacy-callback-routes.test.ts`, Workflow-Contract-Tests                                                                                    |
| T-INFRA-7 | Produktion startet mit Dev-Mailhog-Defaults                                        | Compose `${VAR:?}`, `doctor` SMTP-Gate                                                                                               | `pnpm test:ops`                                                                                                                                                       |
| T-INFRA-8 | Backup existiert, ist aber nicht wiederherstellbar                                 | Restore-Roundtrip, Backup-Drill                                                                                                      | CI `restore`, `backup-drill`, `disaster-recovery.md`                                                                                                                  |
| T-INFRA-9 | Lokaler Build-Cache füllt den Server                                               | automatischer BuildKit-Prune nach Lokalbuild                                                                                         | `pnpm test:ops`, Day-2 Runbook                                                                                                                                        |

## 3. Angriffsvektoren

| Vektor                   | Beispiel                                                                   | Gegenmaßnahme                                                                                                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Direct DB Access**     | Angreifer umgeht App, greift direkt auf DB zu                              | RLS (FORCE + Policy), `taxtronik_app` Role                                                                                                                                                                                                                                                                 |
| **TOCTOU Race**          | Berechtigung gilt beim Precheck, nicht beim Commit                         | Advisory Locks, `$transaction`                                                                                                                                                                                                                                                                             |
| **Mass Assignment**      | Angreifer sendet versteckte Felder mit                                     | Zod-Schemas pro Action, `decideStaffGuard`                                                                                                                                                                                                                                                                 |
| **CSRF**                 | Angreifer forciert POST aus fremdem Origin                                 | SameSite=Lax, Origin-/Fetch-Metadata-Checks, Auth.js/Next.js-Schutz                                                                                                                                                                                                                                        |
| **XSS**                  | Angreifer injiziert Script in Mandantendaten                               | React-Default-Escaping, CSP, E2E 07 (9.1)                                                                                                                                                                                                                                                                  |
| **SQL Injection**        | Angreifer injiziert SQL in Search/Filter                                   | Prisma-Parameterized-Queries, E2E 07 (9.2)                                                                                                                                                                                                                                                                 |
| **File Upload Malware**  | EICAR-Testdatei, Double-Extension                                          | ClamAV, MIME-Check, E2E 07 (10.1-10.3)                                                                                                                                                                                                                                                                     |
| **Brute Force**          | Passwort-, TOTP- oder WebAuthn-Versuchssturm                               | schrittspezifische IP-/Global-Limits + Account-Lockout, E2E 04                                                                                                                                                                                                                                             |
| **WebAuthn Downgrade**   | Hardware-only fällt auf Passwort/OTP zurück                                | Modus-/`authRevision`-Bindung; ausschließlich `security_key`; kein Software-Fallback                                                                                                                                                                                                                       |
| **WebAuthn Replay**      | Challenge oder Assertion wird erneut verwendet                             | atomarer Redis-Consume, Purpose-/RP-/Origin-Bindung, Signaturzähler                                                                                                                                                                                                                                        |
| **WebAuthn Trust Drift** | entferntes oder kompromittiertes Modell bleibt aktiv                       | vollständige `packed`-Attestation samt Zertifikat-AAGUID; FIDO MDS `strict`; signierte BLOB-Serie vor lokalem Modellfilter; zentral gebundene Policy-Revision samt Hash; Exact-State-Lock je Commit in Reihenfolge `MDS -> Staff`; bei MDS-/Netzfehler fail-closed                                         |
| **Attestation-CRL-SSRF** | ein untrusted Zertifikat dereferenziert interne oder umgeleitete CRL-Ziele | Kette und CA-Constraints vor Fetch; nur eine unpartitionierte Voll-CRL-URI über HTTP(S)-Standardports ohne Credentials/Redirect; Delta/IDP/Reasons und unbekannte kritische Extensions fail-closed; authentisierter, begrenzter Cache. CRL-URLs bereits vertrauenswürdiger CAs bleiben Egress-Abhängigkeit |
| **SSRF / DNS-Rebinding** | Admin-konfigurierte URLs zeigen auf interne Netze                          | `safeFetch`, gepinnter Lookup; Infrastruktur-Allowlist gilt nicht für tenantkonfigurierbare Ziele                                                                                                                                                                                                          |
| **Webhook Replay**       | alter n8n-Callback wird erneut gesendet                                    | v1: einmalige Request-ID im fail-closed Redis-Store; Legacy: HMAC + Timestamp + Nonce                                                                                                                                                                                                                      |
| **Dev-Config in Prod**   | Mailhog oder Dev-Secrets gelangen in Production                            | ENV-Denylist, Compose-Pflichtvariablen, `doctor`                                                                                                                                                                                                                                                           |

## 4. Vertrauensgrenzen (Trust Boundaries)

```
┌─────────────────────────────────────────────────────┐
│ Internet (Null-Trust)                                │
│  ├── Staff-User (Passwort/TOTP oder FIDO2-Schlüssel) │
│  ├── Portal-User (Magic-Link)                        │
│  └── Angreifer                                        │
├─────────── Proxy (`proxy.ts`) ──────────────────────┤
│  ├── Surface-Detection (/staff, /portal, /api/...)   │
│  ├── Cookie-Reading (tolerant prefixes)              │
│  └── Tenant-/Host-Aufloesung                          │
├─────────── App-Layer (Next.js) ─────────────────────┤
│  ├── Staff-Action-Guard (RBAC, Object-Gates)         │
│  ├── Portal-Action-Guard                              │
│  ├── withTenantContext (RLS Session)                  │
│  └── evidenceService.record (Audit-Chain)             │
├─────────── Database-Layer (PostgreSQL) ─────────────┤
│  ├── Row-Level Security (ENABLE + FORCE)              │
│  ├── Audit Triggers (prevent_modification)            │
│  └── Advisory Locks (Chain-Integrität)                │
├─────────── Storage-Layer (SeaweedFS S3) ────────────┤
│  ├── Object-Lock (GoBD 6/8/10y, GwG 5y + Review)      │
│  ├── Versioning (staff-private)                       │
│  └── Lifecycle (backups 90d)                          │
└─────────────────────────────────────────────────────┘
```

Der externe FIDO Metadata Service ist eine zusätzliche Vertrauens- und
Verfügbarkeitsgrenze des optionalen Hardware-Zugangs. TaxTronik lädt dessen
signierten Gesamt-BLOB über HTTPS, prüft die Metadaten im Modus `strict` und
sendet dabei keine Staff-/Credential-ID oder AAGUID als Anwendungsparameter.
Benötigte CRLs werden erst nach einem vertrauenswürdigen Kettenaufbau geladen
und kryptografisch an den Issuer gebunden. Mehrere oder gescopte Distribution
Points sowie Delta-/indirekte CRLs werden nicht unvollständig ausgewertet,
sondern blockieren fail-closed. Ihre Betreiber sehen dennoch die
üblichen Verbindungsdaten des Worker- beziehungsweise (Attestations-CRLs beim
Enrollment) App-Servers; die Ziele einer bereits vertrauenswürdigen CA bleiben
eine kontrolliert zuzulassende externe Egress-Fläche. Den MDS-BLOB lädt und
prüft ausschließlich der Worker-Job `fido-mds-refresh`; Hardware-Zeremonien
lesen nur den gespeicherten Stand und kontaktieren den Metadata Service nicht.
DNS, TLS, Systemzeit, Egress und MDS-/CRL-Verfügbarkeit des Workers können
Hardware-Assertions fail-closed blockieren, sobald die letzte erfolgreiche
Prüfung länger als eine Stunde zurückliegt. Die AAGUID identifiziert eine
Modellfamilie, nicht eine individuelle Schlüsselinstanz; zwei Credentials sind
kein kryptografischer Zwei-Geräte-Nachweis.

Der Produktionsstart bindet ausschließlich die lokale Hardware-Policy an die
Datenbank und kontaktiert weder MDS noch CRL-Endpunkte. Eine leere Allowlist
bildet dabei einen zentral deaktivierten Zustand. Stable Replicas benötigen
dieselbe `WEBAUTHN_HARDWARE_POLICY_REVISION` und denselben kanonischen Hash;
eine höhere Revision verdrängt alte Replicas, während dieselbe Revision mit
abweichendem Hash oder eine niedrigere Revision fail-closed abgewiesen wird.

Die signierte Seriennummer eines kryptografisch gültigen MDS-BLOBs wird vor
dem lokalen Allowlist-/Modellfilter monoton übernommen; ein älterer BLOB
(Rollback über einen veralteten CDN-Knoten) wird vom Worker abgewiesen, ohne
den gespeicherten Stand zu verändern. Deshalb verdrängt auch
ein gültiger neuer BLOB ohne lokal nutzbare Modelle ältere Snapshots, bevor der
aktuelle Hardware-Vorgang scheitert. Der prozesslokal ausgewertete Snapshot ist bei jeder
erfolgreichen WebAuthn-Mutation über die exakte Bindung an BLOB-Serie,
Policy-Revision und Policy-Hash sowie einen bis zum Datenbank-Commit gehaltenen
Share-Lock abgesichert. Der MDS-Lock wird vor den Staff-Locks genommen. Ein
Cluster-Knoten kann dadurch nach einem parallel übernommenen neueren MDS- oder
Policy-Stand nicht mehr mit dem älteren Zustand committen.

Für Wiederherstellung und Rollenpflege schützt ein Datenbank-Rollenboden die
Hierarchie: Staff-Akteure können keine ADMIN-Rolle entziehen; eine
PARTNER-Rolle darf nur ein aktiver ADMIN desselben Tenants entziehen. Passwort-
und TOTP-Sicherheitsresets prüfen die Actor-`authRevision` unter den Locks und
widerrufen auch ruhende, noch aktive Hardware-Credentials. Die Owner-CLI gibt
das Klartextpasswort nur in eine exklusiv und ohne Symlink-Folge angelegte Datei
aus, nie in Terminal oder Logs; Teildateien werden bei Ausgabefehlern gezielt
entfernt und Datei sowie POSIX-Elternverzeichnis vor dem DB-Commit
synchronisiert. Scheitert erst dieser Commit, kann eine unwirksame, aber sicher
geschriebene Datei zurückbleiben und muss verworfen werden.

### Datenbankrollen (S-01)

| Rolle             | Verbindung                        | Genutzt von                                                                                                                                       | Rechte                                                                                                                                                                   |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `taxtronik`       | nur Init, `migrate`, Operator-CLI | Initialisierung, Migrationen, Rollensynchronisation, Backup vor Migrationen, Restore                                                              | Superuser                                                                                                                                                                |
| `taxtronik_app`   | `DATABASE_APP_URL` (app, worker)  | Web-Requests und Server Actions; Worker-Jobs mit bekanntem Tenant; n8n-Callbacks nach der Credential-Prüfung; iCal-Feed nach der Tenant-Auflösung | DML nach Grants, immer unter FORCE RLS; ohne Tenant-Kontext keine Zeilen; Sitzungsgrenzen `statement_timeout` 20 s und `idle_in_transaction_session_timeout` 30 s        |
| `taxtronik_owner` | `DATABASE_URL` (app, worker)      | begründete Owner-Pfade (unten)                                                                                                                    | NOSUPERUSER, BYPASSRLS, DML auf allen Tabellen; keine DDL, kein TRUNCATE, keine Rollen oder Datenbanken; `audit_log`, `audit_seal`, `audit_anchor` nur lesen und anfügen |
| `taxtronik_drill` | `DATABASE_DRILL_URL` (nur worker) | monatlicher Restore-Drill                                                                                                                         | CREATEDB und BYPASSRLS für Wegwerf-Datenbanken, keine Rechte in der Produktiv-Datenbank                                                                                  |

Über die App-Rolle im SYSTEM-Kontext des Tenants (`withSystemContext`, im
Worker für Kerne mit eigenem DB-Parameter `systemContextClient`) laufen die
mandantenbezogenen Worker-Jobs (Modulschalter, Fristen und Fristhinweise,
Erinnerungen und Wiedervorlagen, offene Rechnungen, Vollmachten,
GwG-Fristen, Sanktionslisten, Posteingangsbereinigung, Steuernachrichten,
Workflow-Wiederaufnahme und n8n-Übergaben, Update-Prüfung,
Risikoanreicherung, Ergebnisse und Hinweise von Kettenprüfung und
Restore-Drill, Anker-Status, Tagessiegel, TSA-Auswahl), die n8n-Callbacks
(überfällige Anforderungen, Anforderungsdetails, ablaufende GwG-Prüfungen,
Receipt-Recovery, Rechercheergebnisse), der iCal-Feed und die Vorlagen- und
Empfängerauflösung des gemeinsamen Mail-Versands. Der manuelle
Steuernachrichten-Abruf im Dashboard läuft vollständig im Kontext des
angemeldeten Mitarbeiters (`withTenantContext`), einschließlich des globalen
Nachrichten-Caches. Je Pfad belegt eine PostgreSQL-Suite mit gesperrtem
Owner-Client die App-Rolle, dieselben Zeilen wie zuvor und die Unsichtbarkeit
fremder Tenants.

Beim Owner-Client bleiben, jeweils mit Begründung im Code beziehungsweise in
der Owner-Allowlist (`prisma-client-guard.test.ts`):

- Auflösungen vor jedem Tenant-Kontext: Login, Magic-Link, WebAuthn,
  Token-Flows (GwG-Onboarding, Vollmachtssignatur, Audit-Nachweis), die
  Credential-Prüfung der n8n-Callbacks, die Tenant-Auflösung des iCal-Feeds,
  die Korrelations-ID des Legacy-Recherche-Callbacks sowie die
  mandantenübergreifenden Tenant-Listen und Kandidatensuchen der Worker (nur
  IDs; beim Steuernachrichten-Job Tenant und Feed-URL) und der globale,
  mandantenfreie Nachrichten-Cache dieses Jobs;
- Wartung über alle Tenants: Audit-Archivierung, Anker-Lease und Anker,
  Prüf-Checkpoints der Kettenprüfung, Backup und Restore-Drill,
  DSGVO-Aufbewahrung, Bereinigung abgelaufener Magic-Links, der n8n-Outbox und
  verwaister Speicherobjekte, Betriebsüberwachung und FIDO-MDS-Stand;
- bewusst fehlende App-Rechte: Zustellung der Mail-Outbox (die App-Rolle darf
  `mail_outbox` nur anlegen und lesen) sowie n8n-Zustellung und -Enqueue
  (tenantlose Ereignisse, global eindeutige Dedupe-Schlüssel);
- offen: automatische Feedback-Einladungen (`workflow-feedback`; die Policies
  von `client_interaction` kennen keinen SYSTEM-Akteur).

**Restrisiko:** Die Owner-Zugangsdaten liegen weiterhin in den Containern
`app` und `worker`. Codeausführung oder SQL-Injection auf einem Owner-Pfad
erreicht damit alle Mandantendaten lesend und schreibend (BYPASSRLS), aber
keine Schemaänderung, Rechteausweitung, `COPY … PROGRAM` oder Abschaltung von
Triggern; die Hash-Chain-Tabellen bleiben append-only. Auf Owner-Pfaden
schützt vor einem fehlenden Tenant-Filter nur der Code. Der SYSTEM-Akteur der
App-Rolle sieht innerhalb seines Tenants die meisten Tabellen: Ein Fehler in
einem Job wirkt im eigenen Tenant breit, aber nicht über Tenant-Grenzen. Die
Worker-Jobs auf der App-Rolle unterliegen den Sitzungsgrenzen und dem Pool
der App-Verbindung des Workers.

## 5. Referenzen

- ADR 0002: RLS und App-Level-Tenancy
- ADR 0003: getrennte Staff-/Portal-Auth-Surfaces
- ADR 0010: JWT-Sessions, Modusbindung und Widerruf
- ADR 0012: Schema-Drift-Detection
- `docs/compliance/tenancy-model.md`
- `docs/compliance/gobd.md`
- `docs/compliance/gwg.md`
