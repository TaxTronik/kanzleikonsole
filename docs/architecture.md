# Architektur

Dieses Dokument fasst die Architektur von taxtronik zusammen. Der vollständige
Plan (mit Iterationen, Entities, Risiken) liegt unter
`~/.claude/plans/hey-claude-ich-will-zazzy-noodle.md`.

## Stack im Überblick

```
        ┌────────────────────────────────────────────────┐
        │  Browser (Mitarbeiter / Mandant)               │
        └───────────────┬────────────────────────────────┘
                        │ HTTPS
        ┌───────────────▼────────────────────────────────┐
        │  app  (Next.js 16 — UI + API + Server Actions) │
        └─┬──────┬──────┬──────────┬─────────┬───────────┘
          │      │      │          │         │
       Postgres  Redis  SeaweedFS ClamAV    n8n (Webhooks raus)
       (RLS)    (BullMQ) (Object  (Virus-   (Mail/Reminder/Cron)
                          Lock)   Scan)
                ▲                            │
                │                            │ HMAC-signierte Calls
                │                            ▼
        ┌───────┴────────────────────────────────────────┐
        │  worker (Node + BullMQ)                        │
        │  - Virus-Scan (asynchron)                      │
        │  - PDF-Generierung                             │
        │  - Hash-Chain-Versiegelung (täglich, RFC-3161) │
        │  - BWA-Auswertung                              │
        └────────────────────────────────────────────────┘
```

## Kern-Prinzipien

1. **Identitätstrennung Mitarbeiter vs Mandant** — zwei separate Tabellen,
   zwei Auth.js-Instanzen, zwei Cookies (`/staff/*` und `/portal/*`).
   Siehe ADR 0003.

2. **Doppelte Verteidigung Mandanten-Trennung** — App-Level-Filter UND
   Postgres-RLS. Siehe ADR 0002.

3. **Manipulationsevidenz via Hash-Chain + RFC-3161** — jede compliance-
   relevante Schreiboperation landet in `audit_log`, hash-verkettet pro Tenant.
   Worker versiegelt täglich den Tages-Spitzen-Hash mit RFC-3161. Verifikation
   per CLI (`pnpm verify:chain`).

4. **n8n für Kommunikation, Code für Compliance** — Reminder, Mails, Eskalationen
   laufen in n8n. Auth, Audit, Storage, GwG-Schranke sind eigenständiger Code
   in der App (zu kritisch für externe Workflow-Engine).

5. **Externe Integrationen erst nach Process-Proof** — DATEV/Transparenz­register/
   ELSTER kommen NICHT im MVP. Stattdessen manueller Excel-/PDF-Import.

6. **GwG-Schranke systemisch** — DB-Trigger (`enforce_client_active_for_document`)
   plus App-Guard verhindern Mandantenanlage und alle client-bezogenen
   Operationen, solange `client.allow_active = false`. Wird ab Iter. 4 vom
   verifizierten `gwg_check` gesetzt.

## Repositorystruktur

Siehe README.md für die vollständige Folder-Übersicht.

## Compliance-Mapping

| Anforderung | Wo umgesetzt |
|---|---|
| § 203 StGB Steuergeheimnis | RLS-Policies in `packages/db/prisma/migrations/.../migration.sql`; `withTenantContext` in `packages/db/src/tenant-context.ts` |
| GoBD Unveränderlichkeit | SeaweedFS Object-Lock (Bucket `gobd`, COMPLIANCE-Mode, 10 Jahre Default-Retention); `document_version.immutable` mit DB-Trigger; `audit_log` insert-only mit Trigger |
| GoBD Nachvollziehbarkeit | Hash-verkettetes `audit_log` (`packages/evidence/src/service.ts`) |
| GoBD Aufbewahrungsfrist | `document.retention_until` plus Object-Lock-Default-Retention im `gobd`-Bucket |
| DSGVO Datensparsamkeit | RLS verhindert "Vergessens-Bug"; explizites Audit nur compliance-relevanter Operationen |
| GwG Identifizierungspflicht | Iter. 4: `gwg_check`-Tabelle, Excel-Import für Transparenzregister |
| GwG Risikoanalyse | Iter. 4: `gwg_risk_score`, regelbasierte Engine, Gewichtungen pro Kanzlei |
| GwG Vorgangs-Block | DB-Trigger auf `client.allow_active = false` plus App-Guard |
| eIDAS Vollmachten | Iter. 5: `EidasSignaturePort` mit OTP-Adapter (MVP) und QES-Plug-in (später) |

## Querverweise

- ADR 0001: Monorepo-Setup
- ADR 0002: RLS und App-Level-Tenancy
- ADR 0003: Zwei Auth-Surfaces
- ADR 0004 (folgt): n8n-Integration
- ADR 0005 (folgt): Update-Mechanik mit signiertem Manifest
