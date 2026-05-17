# ADR 0012 — Prisma-Migration vs. Hand-SQL: Drift-Check als CI-Gate

**Status**: Akzeptiert (Iteration 2), CI-tauglich seit Iter. 46 (D2)
**Datum**: 2026-05-13 (initial), 2026-05-13 (Update D2)

> **Update 2026-05-13 (D2)** — Drift-Check ist jetzt hartes CI-Gate. Zwei
> Anpassungen:
>
> 1. **Script umgestellt auf `--from-schema-datasource`** (statt
>    `--from-migrations` + shadow). Das Script resetted erst die Shadow-DB
>    via `prisma migrate reset`, dann werden alle Migrationen applied,
>    dann wird der Live-Stand der Shadow-DB gegen schema.prisma diffed.
>    Vorteil: Prisma's Introspection erkennt installierte Extensions korrekt
>    (Phantom-Drift bei citext/pg_trgm/pgcrypto entfällt).
>
> 2. **schema.prisma getightet** via `prisma db pull` (verlustfreie
>    Übernahme aller @db.Timestamptz, @relation(map:...), @@index(map:...),
>    @@id(map:...)-Annotationen aus der migrierten DB). Die Source-of-Truth
>    für Constraint- und Index-Namen sind die Hand-SQL-Migrationen — schema.prisma
>    spiegelt das jetzt 1:1 wider.
>
> Resultat: `pnpm verify:schema-drift` exit 0. Jede künftige Schema-Änderung
> ohne Migration (oder Migration ohne Schema-Update) wird vom Gate gefangen.
**Kontext**: Security-Review Q10 hat angemerkt, dass die initiale Migration
(`20260510000000_init/migration.sql`) ~400 Zeilen handgepflegtes SQL enthält
— gemischt mit Prisma-managed Migrations. Risiko: Schema-Drift zwischen
`schema.prisma` und dem tatsächlich gemigreten DB-Stand. Bei jeder
Schema-Änderung kann unbemerkt eine Lücke entstehen.

## Entscheidung

Wir behalten die Mischarchitektur (Prisma generiert Tabellen-Diffs,
handgepflegte SQL-Migrationen für RLS-Policies, Trigger und Indizes).
Aber: **`prisma migrate diff` als Drift-Check** wird als
`pnpm verify:schema-drift`-Script bereitgestellt und ist Pflicht-Gate
in CI vor jedem Merge.

## Begründung

### Warum Hand-SQL?

Prisma kann viele compliance-kritische DB-Features nicht selbst generieren:
- **Row-Level Security**: `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY ...`
- **FORCE RLS** (siehe [Iter 42](../../packages/db/prisma/migrations/20260623000000_iter42_force_rls/migration.sql))
- **Trigger**: `audit_log_no_modify`, `document_version_immutable_protect`,
  `enforce_client_active_for_document` (GwG-Schranke)
- **REVOKE-Statements** auf Audit-Tabellen
- **GIN-Indizes** für Postgres-Volltextsuche (`tsvector`)
- **Schema-übergreifende Funktionen** in `app`-Schema

Prisma würde diese Strukturen beim `migrate dev --create-only` ignorieren
oder versuchsweise droppen. Die Mischarchitektur ist unvermeidlich.

### Wie der Drift-Check funktioniert

`prisma migrate diff` kann zwei Schema-Stände vergleichen:
- **Quelle A**: alle Migrationen ausgeführt → "tatsächlicher DB-Stand"
- **Quelle B**: `schema.prisma` → "ORM-erwarteter Stand"

Wenn diese auseinanderlaufen (z. B. weil jemand `schema.prisma` ändert,
aber die Migration vergisst), gibt der Diff eine non-empty DDL aus und
exit-code != 0.

Das Script:
```bash
pnpm verify:schema-drift
```

läuft eine temporäre Migration-Shadow-DB hoch, applied alle Migrationen,
diffed gegen `schema.prisma` und fails wenn Diff non-empty ist.

Es ist **kein** Ersatz für RLS-Tests (die testen das Verhalten, nicht das
Schema) und **kein** Ersatz für die Cross-Tenant-Test-Suite. Aber es fängt:
- Vergessene Migration nach Schema-Änderung
- Tippfehler in Hand-SQL, die das ORM-Mapping brechen
- Zurückgerollte Migrationen, die schema.prisma weiter modifiziert
- Mehrere parallele PRs, die sich in Migrationen widersprechen

### Was NICHT erkannt wird

- Logische Schäden: Trigger korrekt da, aber falsche Bedingung
- RLS-Policy korrekt da, aber leakt durch fehlerhafte App-Logik
  → dafür ist die RLS-Test-Suite zuständig
- Hand-SQL, das schema.prisma nicht beeinflusst (z. B. zusätzliche
  Indizes, Functions im `app`-Schema)

### Frühere bekannte Drift (gelöst in Iter. 46 / D2)

Bis Iter. 45 meldete der Check Drift in mehreren Bereichen, die historisch
als "akzeptable Kosten" der Mischarchitektur dokumentiert waren:

- ~~Postgres-Extensions~~ — gelöst durch Script-Umstellung auf
  `--from-schema-datasource` (Prisma's Introspection erkennt installierte
  Extensions korrekt)
- ~~Foreign-Key-Namen~~ — gelöst durch `@relation(map: "<name>")` Annotationen
- ~~Column-Typen `timestamptz` vs. `timestamp`~~ — gelöst durch
  `@db.Timestamptz(6)` Annotationen auf allen relevanten Feldern (32 Felder)
- ~~Index-Namen~~ — gelöst durch `@@index(name: "<name>")` Annotationen (126
  Entries, via `prisma db pull` extrahiert)

Alle vier sind seit dem D2-Update aufgelöst. Der Check ist jetzt **binäres
CI-Gate** — exit 0 wenn schema.prisma die Migrationen exakt abbildet.

## Konsequenzen

**Was wir tun**
- `packages/db/scripts/verify-drift.ts` (kommt mit diesem ADR)
- `pnpm verify:schema-drift` Top-Level-Script
- CI fügt diesen Schritt vor `prisma migrate deploy` ein (sobald CI existiert)

**Verworfene Alternativen**
- **Nur Prisma-generierte Migrationen**: würde alle RLS/Trigger/Functions
  in `migrate dev` zerstören (Prisma kennt sie nicht). Nicht machbar.
- **`prisma db pull` nach jeder Hand-Migration**: würde `schema.prisma`
  mit irrelevanten DB-Internals zuschütten (z. B. Index-Namen, die Prisma
  sonst nicht reflektiert).
- **DBmate / Sqitch statt Prisma-Migrationen**: zusätzlicher Tool-Stack,
  keine Vorteile gegenüber `prisma migrate deploy`.
