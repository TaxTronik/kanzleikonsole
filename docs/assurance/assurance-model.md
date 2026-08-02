# TaxTronik Assurance Model

> **Keine Kontrollbehauptung ohne Gegenbeweis. Kein Release ohne bestandene Vertrauensprüfung.**

Dieses Dokument beschreibt, wie TaxTronik Vertrauen erzeugt — nicht durch
Behauptungen, sondern durch maschinell nachprüfbare Garantien.

## Architektur-Übersicht

```
┌─────────────────────────────────────────────────────────┐
│  1. Threat Model                                        │
│     Kronjuwelen · "Was niemals passieren darf"          │
├─────────────────────────────────────────────────────────┤
│  2. Security Boundaries                                 │
│     Proxy → App-Gate → withTenantContext → RLS → S3    │
├─────────────────────────────────────────────────────────┤
│  3. Policy Model                                        │
│     decideStaffGuard · decideClientAccess · RLS        │
├─────────────────────────────────────────────────────────┤
│  4. Test Layers                                         │
│     Unit → Property → Integration → E2E → Differential │
├─────────────────────────────────────────────────────────┤
│  5. Release Gates (CI)                                  │
│     verify:rls · verify:chain · verify:schema-drift    │
│     gitleaks · pnpm audit · paranoid E2E · Trivy       │
├─────────────────────────────────────────────────────────┤
│  6. Evidence / Audit Guaranties                         │
│     Hash-Chain · RFC 3161 TSA · Audit-Archive (S3)     │
├─────────────────────────────────────────────────────────┤
│  7. Known Limits                                        │
│     Was TaxTronik NICHT ersetzt                         │
├─────────────────────────────────────────────────────────┤
│  8. External Review Roadmap                             │
│     security.txt · Pen-Test · PS 880 Readiness         │
└─────────────────────────────────────────────────────────┘
```

---

## 1. Threat Model

**Dokument:** [`threat-model.md`](./threat-model.md)

Definiert die Kronjuwelen (Mandantendaten, Audit-Chain, GwG, Evidence Packs)
und für jedes Modul die Invariante "Was muss niemals passieren".

Jede Invariante ist mit der konkreten Schutzschicht und dem prüfenden Test
verknüpft. Neue Module MÜSSEN vor Merge ihre Invarianten hier eintragen.

## 2. Security Boundaries

Fünf harte Schichten, die ein Angreifer überwinden muss:

| Schicht             | Technologie                                  | Durchbruch-Schutz                                                                                                                               |
| ------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Proxy**           | Next.js 16 `proxy.ts`                        | Surface-Detection, Session-/Host-Routing                                                                                                        |
| **App-Gate**        | `staffActionGuard`, `portalActionGuard`      | RBAC, Object-Gates, `decideStaffGuard`                                                                                                          |
| **Tenant-Kontext**  | `withTenantContext` (Postgres `SET LOCAL`)   | Session-scoped RLS-Kontext pro Transaction                                                                                                      |
| **RLS (Datenbank)** | Postgres `ENABLE + FORCE ROW LEVEL SECURITY` | `taxtronik_app` Role, Policy pro Tabelle                                                                                                        |
| **Storage**         | SeaweedFS S3 + Object-Lock                   | GoBD typabhängig 6/8/10 J.; GwG grundsätzlich 5 J. plus Prüfung längerer Pflichten und Vernichtung spätestens nach 10 J.; Versioning, Lifecycle |

**Verteidigung in der Tiefe:** App-Filter UND RLS filtern unabhängig. Ein
Fehler in einer Schicht wird von der anderen abgefangen.

## 3. Policy Model

| Entscheidung          | Reine Funktion                     | Property-Based Test                    |
| --------------------- | ---------------------------------- | -------------------------------------- |
| Admin/Permission-Gate | `decideStaffGuard`                 | `staff-action-policy.property.test.ts` |
| Mandanten-Zugriff     | `decideClientAccess`               | `access-policy.property.test.ts`       |
| RLS-Policy            | Postgres `app.current_tenant_id()` | `rls-cross-tenant.test.ts`             |

**Zentralisierungsregel:** Admin-Checks NIE verstreut im Code. ESLint-Regel
(`no-restricted-syntax`) verbietet `roles?.some(... === 'ADMIN')` — zwingt
zu `isStaffAdmin(session)`. AST-Guard (`server-action-authz.test.ts`)
überprüft, dass jede Server Action ein Auth-Primitiv referenziert.

## 4. Test Layers

| Layer                      | Tool                        | Umfang                                                         | Trigger                         |
| -------------------------- | --------------------------- | -------------------------------------------------------------- | ------------------------------- |
| **Unit**                   | vitest                      | Web, Worker und Packages                                       | Jeder Commit (`turbo run test`) |
| **Property-Based**         | fast-check                  | Policy-, Hash- und Fachinvarianten                             | Jeder Commit (in vitest)        |
| **Operator CLI**           | Bash                        | `doctor`, SMTP, Risk-Layer, Build-Cache-Prune                  | CI `quality` Job                |
| **Integration (DB)**       | vitest + Postgres           | RLS, Festschreibung, GwG und Concurrency                       | CI `db` Job                     |
| **E2E Smoke**              | Playwright                  | separate öffentliche/authentifizierte Smoke-Suite              | CI `e2e-smoke` Job              |
| **E2E Paranoid (Release)** | Playwright                  | Auth, Actions, Compliance, RBAC, Differential und Negativfälle | CI `e2e-paranoid` Job           |
| **Differential**           | Playwright + Referenz       | API-/DB-/Storage-/UI-Invarianten                               | In paranoid Suite               |
| **Concurrency**            | Playwright + `Promise.all`  | parallele Dokument- und Versionsschreibvorgänge                | In paranoid Suite               |
| **Upload Fuzz**            | Playwright + Negative Cases | Upload-Validierung, Header- und Origin-Negativfälle            | In paranoid Suite               |

## 5. Release Gates (CI)

| Gate                 | Befehl                                 | Was prüft es                                                                                                                                          | CI Job             |
| -------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **Format**           | `pnpm format:check`                    | Reproduzierbare Prettier-Baseline für TypeScript, JavaScript, JSON und Markdown                                                                       | `quality`          |
| **Lint + TypeCheck** | `pnpm lint && pnpm typecheck`          | Repository-weites ESLint, `no-explicit-any: error`, tsc strict                                                                                        | `quality`          |
| **Operator CLI**     | `pnpm test:ops`                        | Prod-Env-Gates, Mailhog-Verbot, Risk-Layer-Paarung, Build-Cache-Prune                                                                                 | `quality`          |
| **Schema-Drift**     | `pnpm verify:schema-drift`             | schema.prisma vs Migrationen                                                                                                                          | `db`               |
| **RLS-Drift**        | `pnpm verify:rls`                      | Jede Tabelle hat ENABLE+FORCE RLS + Policy                                                                                                            | `db`               |
| **Audit-Chain**      | `pnpm verify:chain`                    | Hash-Chain recompute, TSA-Verify, Archive                                                                                                             | `db`               |
| **Secret-Scan**      | `gitleaks detect`                      | Vollständige Git-Historie, Log als Artefakt                                                                                                           | `security`         |
| **Dependency-Audit** | `pnpm audit --prod --audit-level high` | Bekannte Vulnerabilitäten (blockierend); täglich. Zusätzlich nicht-blockierender Vollauf über den gesamten Graphen inkl. Dev. Beide Logs als Artefakt | `security`         |
| **Paranoid E2E**     | Playwright-Suite                       | Auth, RBAC, Tenant-Isolation, Compliance                                                                                                              | `e2e-paranoid`     |
| **XRechnung**        | KoSIT Validator                        | Schematron + BR-DE Konformität                                                                                                                        | `e-rechnung`       |
| **Container-Scan**   | Trivy                                  | CRITICAL-with-fix blockiert Release                                                                                                                   | `release`          |
| **Image-Runtime**    | Release-Compose-Smoke                  | Finale Web-/Worker-Images, Migration, Readiness, Heartbeat, Image-ID und OCI-Commit vor Push                                                          | `release`          |
| **Image-SBOM**       | Trivy CycloneDX                        | Komponenten-Inventar getrennt für die finalen Web-/Worker-Images                                                                                      | `release`          |
| **Backup-Restore**   | pg_dump/pg_restore Roundtrip           | Backup ist wiederherstellbar                                                                                                                          | `restore`          |
| **Deploy-Readiness** | `pnpm verify:deploy-readiness`         | Prod-Konfig gegen echte Compose-Infra: S3-Buckets + Object-Lock, ClamAV-StreamMaxLength + Signaturen (EICAR), Storage-Roundtrip                       | `deploy-readiness` |

**Guard-Skripte (CI-Job `quality`, keine lokalen Hooks):**
`check-no-focused-tests`, `check-paranoid-e2e`,
`check-ci-images-pinned`, `check-ci-actions-pinned`, `check-no-real-datev`,
`check-no-eric-spec`, `check-docker-bases-pinned`.

## 6. Evidence / Audit Guaranties

| Garantie                  | Mechanismus                                                                     | Verify-Pfad                                     |
| ------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Unveränderlichkeit**    | `prevent_modification()` Trigger auf `audit_log`, `audit_seal`, `audit_archive` | Trigger wirft `restrict_violation`              |
| **Hash-Chain-Integrität** | SHA-256(prev_hash \|\| canonicalEvent)                                          | `verify:chain` CLI recompute, vergleicht mit DB |
| **Externes Timestamp**    | RFC 3161 TSA (GlobalSign)                                                       | `rfc3161-verify.test.ts`, TSA-Root-Pinning      |
| **Chain-Verifikation**    | Recompute, nicht Trust-Stored-Column                                            | `service-verifychain.test.ts`                   |
| **Audit-Label-Coverage**  | AST-Scan der statisch emittierten `evidenceService.record`-Action-Keys          | `audit-label-coverage.test.ts`                  |
| **Archive-Verify**        | NDJSON in S3, SHA-256 vs DB                                                     | `verify:chain` CLI prüft Archive-Segmente       |

**Hash-Chain Property Tests:** Determinismus (C1), Key-Reihenfolge-Egal (C2),
undefined/null-Handling (C3-C4), Event-Hash-Determinismus (H1),
Action-Sensitivität (H2), prevHash-Sensitivität (H3).

## 7. Known Limits

**Dokument:** [`known-limits.md`](./known-limits.md)

Ehrliche Dokumentation dessen, was TaxTronik NICHT leistet — von "ersetzt keine
fachliche Würdigung" bis "RLS ist die letzte Barriere, nicht die einzige".

## 8. External Review Roadmap

| Phase                | Maßnahme                                                | Status                                               |
| -------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| **Jetzt**            | `SECURITY.md` für Responsible Disclosure                | [`SECURITY.md`](../../SECURITY.md)                   |
| **Jetzt**            | CycloneDX-SBOM pro finalem Release-Image                | In `release.yml` implementiert                       |
| **Nächstes Quartal** | Externer Code-Audit für Kernmodule (RLS, Audit, RBAC)   | Geplant                                              |
| **Pre-Launch**       | Penetrationstest (OWASP Top 10, API, Auth)              | Roadmap                                              |
| **Pre-Launch**       | PS 880 Readiness Dokumentation                          | `docs/compliance/idw-ps880-pruefungsbereitschaft.md` |
| **Post-Launch**      | Erweiterter Supply-Chain-Review (Dependency-Provenance) | Roadmap                                              |
| **Post-Launch**      | Annual Security Re-Review                               | Roadmap                                              |

---

## Referenzen

- [Threat Model](./threat-model.md)
- [Known Limits](./known-limits.md)
- [Day-2 Operations](../operations/day-2-operations.md)
- [Secret-Rotation](../operations/secret-rotation.md)
- [Release-Rehearsal](../operations/release-rehearsal.md)
- [ADR 0002: RLS und App-Level-Tenancy](../adr/0002-rls-und-app-level-tenancy.md)
- [ADR 0012: Prisma Migration Drift Check](../adr/0012-prisma-migration-drift-check.md)
- [Tenancy Model](../compliance/tenancy-model.md)
- [GoBD Compliance](../compliance/gobd.md)
- [GwG Compliance](../compliance/gwg.md)
- [Zugriffsschutz](../development/module/zugriffsschutz.md)
- [Testkonzept](../development/testkonzept.md)
