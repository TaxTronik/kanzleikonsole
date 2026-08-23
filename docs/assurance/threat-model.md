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

| ID      | Was muss niemals passieren                                     | Schicht                                  | Test                                                       |
| ------- | -------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| T-ISO-1 | Ein User sieht Daten eines anderen Tenants                     | RLS + App-Filter                         | `rls-cross-tenant.test.ts`, E2E 07 (5.1-5.4), `verify:rls` |
| T-ISO-2 | Eine Server Action umgeht Object Gates                         | `staffActionGuard` / `portalActionGuard` | `server-action-authz.test.ts` (AST-Guard)                  |
| T-ISO-3 | Eine Query ohne `withTenantContext` läuft gegen Mandantendaten | PrismaClient-Guard                       | `prisma-client-guard.test.ts` (AST-Guard)                  |
| T-ISO-4 | Eine neue Tabelle ohne RLS wird hinzugefügt                    | FORCE RLS + Drift-Gate                   | `verify:rls` in CI                                         |

### 2.2 Audit-Chain / GoBD

| ID      | Was muss niemals passieren                                | Schicht                                    | Test                                                                                              |
| ------- | --------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| T-AUD-1 | Eine audit-pflichtige Mutation erzeugt kein Audit-Event   | transaktionales `evidenceService.record`   | Modulspezifische Action-Tests; kein vollständiger globaler AST-Nachweis                           |
| T-AUD-2 | Die Hash-Chain ist inkonsistent (Manipulation erkannt)    | SHA-256 + RFC 3161                         | `verify:chain` CLI, `service-verifychain.test.ts`, `canonical-json.property.test.ts`              |
| T-AUD-3 | Ein Audit-Eintrag wird nachträglich geändert              | `prevent_modification()` Trigger           | `rls-cross-tenant.test.ts`                                                                        |
| T-AUD-4 | Ein Quantenlos-Nachweis passt nicht zum gebundenen Rahmen | Commitment + gespeicherter Nachweis/Rahmen | `packages/risk-layer/src/__tests__/los.test.ts`, `apps/web/src/server/risk/__tests__/los.test.ts` |

### 2.3 Authentifizierung & Berechtigungen

| ID       | Was muss niemals passieren                                  | Schicht                             | Test                                                  |
| -------- | ----------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------- |
| T-AUTH-1 | Ein nicht-eingeloggter User erreicht eine geschützte Action | `staffActionGuard` / Session-Cookie | `server-action-authz.test.ts`, E2E 09                 |
| T-AUTH-2 | Ein Nicht-Admin führt Admin-Aktionen aus                    | `decideStaffGuard`                  | `staff-action-policy.property.test.ts`, E2E 07 (11.2) |
| T-AUTH-3 | Eine Session bleibt nach Logout aktiv                       | Cookie-Clearing, Revocation         | E2E 07 (6.2), `revocation.ts`                         |
| T-AUTH-4 | TOTP wird umgangen (außer DEV_SKIP_TOTP in CI)              | `authorize` Callback                | `staff.ts` DEV_SKIP_TOTP double-gate                  |

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

| Vektor                   | Beispiel                                           | Gegenmaßnahme                                                                                     |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Direct DB Access**     | Angreifer umgeht App, greift direkt auf DB zu      | RLS (FORCE + Policy), `taxtronik_app` Role                                                        |
| **TOCTOU Race**          | Berechtigung gilt beim Precheck, nicht beim Commit | Advisory Locks, `$transaction`                                                                    |
| **Mass Assignment**      | Angreifer sendet versteckte Felder mit             | Zod-Schemas pro Action, `decideStaffGuard`                                                        |
| **CSRF**                 | Angreifer forciert POST aus fremdem Origin         | SameSite=Lax, Origin-/Fetch-Metadata-Checks, Auth.js/Next.js-Schutz                               |
| **XSS**                  | Angreifer injiziert Script in Mandantendaten       | React-Default-Escaping, CSP, E2E 07 (9.1)                                                         |
| **SQL Injection**        | Angreifer injiziert SQL in Search/Filter           | Prisma-Parameterized-Queries, E2E 07 (9.2)                                                        |
| **File Upload Malware**  | EICAR-Testdatei, Double-Extension                  | ClamAV, MIME-Check, E2E 07 (10.1-10.3)                                                            |
| **Brute Force**          | Passwort- oder TOTP-Brute-Force                    | IP-RL + Account-Lockout, E2E 04                                                                   |
| **SSRF / DNS-Rebinding** | Admin-konfigurierte URLs zeigen auf interne Netze  | `safeFetch`, gepinnter Lookup; Infrastruktur-Allowlist gilt nicht für tenantkonfigurierbare Ziele |
| **Webhook Replay**       | alter n8n-Callback wird erneut gesendet            | v1: einmalige Request-ID im fail-closed Redis-Store; Legacy: HMAC + Timestamp + Nonce             |
| **Dev-Config in Prod**   | Mailhog oder Dev-Secrets gelangen in Production    | ENV-Denylist, Compose-Pflichtvariablen, `doctor`                                                  |

## 4. Vertrauensgrenzen (Trust Boundaries)

```
┌─────────────────────────────────────────────────────┐
│ Internet (Null-Trust)                                │
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

## 5. Referenzen

- ADR 0002: RLS und App-Level-Tenancy
- ADR 0012: Schema-Drift-Detection
- `docs/compliance/tenancy-model.md`
- `docs/compliance/gobd.md`
- `docs/compliance/gwg.md`
