# Architecture Decision Records

Hier dokumentieren wir die Architektur-Entscheidungen, die zum aktuellen
Stand der Codebasis geführt haben — und vor allem **warum** wir sie
getroffen haben. Format inspiriert von Michael Nygard.

## Index

| Nr.                                                   | Titel                                                       | Status       | Iter.   |
| ----------------------------------------------------- | ----------------------------------------------------------- | ------------ | ------- |
| [0001](./0001-monorepo-pnpm-turborepo.md)             | Monorepo mit pnpm + Turborepo                               | Akzeptiert   | 1       |
| [0002](./0002-rls-und-app-level-tenancy.md)           | Multi-Tenant via RLS + App-Level-Filter                     | Akzeptiert   | 1       |
| [0003](./0003-zwei-auth-surfaces.md)                  | Zwei Auth-Surfaces (Staff + Portal)                         | Akzeptiert   | 1, 2    |
| [0004](./0004-evidence-chain-mit-rfc3161.md)          | Manipulationsevidenz: Hash-Chain + RFC-3161                 | Akzeptiert   | 1, 7    |
| [0005](./0005-storage-seaweedfs-objectlock-clamav.md) | Storage: SeaweedFS + Object-Lock + ClamAV (ersetzt MinIO)   | Akzeptiert   | 1       |
| [0006](./0006-n8n-statt-eigencode-fuer-workflows.md)  | n8n statt Eigencode für Workflows                           | Akzeptiert   | 2       |
| [0007](./0007-gwg-schranke-via-db-trigger.md)         | GwG-Schranke via DB-Trigger                                 | Akzeptiert   | 1, 4    |
| [0008](./0008-xrechnung-zugferd-en16931.md)           | XRechnung 3.0.2 + ZUGFeRD/Factur-X                          | Akzeptiert   | 5b      |
| [0009](./0009-eidas-aes-via-token-und-otp.md)         | Elektronischer Vollmachtsnachweis via Token und E-Mail-Code | Revidiert    | 5, 107  |
| [0010](./0010-session-strategie-und-cookie-scope.md)  | Session-Strategie (JWT) und Cookie-Scope                    | Akzeptiert   | 1       |
| [0011](./0011-n8n-fire-and-forget-statt-outbox.md)    | n8n-Events: Outbox statt fire-and-forget                    | Aktualisiert | 45      |
| [0012](./0012-prisma-migration-drift-check.md)        | Prisma-Migration vs. Hand-SQL: Drift-Check                  | Akzeptiert   | 2, 46   |
| [0013](./0013-workflow-spezifische-n8n-ziele.md)      | Workflow-spezifische n8n-Ziele und explizites Routing       | Akzeptiert   | Release |

## Wann ein ADR?

Schreibe einen, wenn die Entscheidung:

- **strukturell** ist (betrifft mehrere Module / das ganze System)
- **schwer rückgängig zu machen** ist (Schema-Änderung, Library-Wahl)
- **kontrovers** ist (es gab valide Alternativen)
- **regulatorisch** motiviert ist (GoBD, GwG, DSGVO, eIDAS)

**Nicht** für: alltägliche Code-Entscheidungen, kleine Refactorings,
Bug-Fixes.

## Format

```markdown
# ADR XXXX — Titel

**Status**: (Vorschlag | Akzeptiert | Abgelöst durch ADR-YYYY | Verworfen)
**Datum**: YYYY-MM-DD
**Kontext**: Problem, das gelöst werden soll. Was zwingt zur Entscheidung?

## Entscheidung

Was haben wir entschieden?

## Konsequenzen

- Vorteile
- Nachteile
- Erweiterungspfade

## Alternativen verworfen

Was wir abgelehnt haben — und warum.
```
