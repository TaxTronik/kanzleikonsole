# ADR 0002 — Doppelte Verteidigung: RLS + App-Level-Tenancy

**Status**: Akzeptiert
**Datum**: 2026-05-10

## Kontext

taxtronik verarbeitet Mandantendaten unter § 203 StGB (Steuergeheimnis).
Eine vergessene `where { tenantId }`-Klausel in einer Prisma-Query wäre
ein Strafbestand, nicht „nur" ein Bug. Reine App-Level-Filter sind
fragil gegenüber Refactorings, Copy-Paste-Fehlern und vergessenen Joins.

Reine Postgres-RLS ist robuster, aber:

- Prisma kennt RLS-Kontext nicht nativ.
- Pagination/Joins/Performance sind ohne explizite App-Filter unbequem.
- Lese-Pfade ohne RLS-Kontext (z. B. CLI, Worker-System-Jobs) müssen
  möglich sein.

## Entscheidung

**Beide Schichten gleichzeitig**:

1. **App-Level**: jede Domain-Operation läuft durch `withTenantContext(ctx, tx => ...)`
   (`packages/db/src/tenant-context.ts`). Der Wrapper
   - öffnet eine Prisma-Transaktion,
   - setzt `app.current_tenant_id`, `app.current_actor_id`, `app.current_actor_type`
     via `set_config(_, _, true)`,
   - übergibt einen Tx-Client an den Callback.

2. **Postgres-RLS**: jede tenant-scoped Tabelle hat `ENABLE ROW LEVEL SECURITY`
   plus eine Policy `tenant_id = app.current_tenant_id()`. Die Funktion
   liegt im Schema `app` und liest die Session-Variable.

3. **Owner vs App-Role**: Migrationen laufen als `taxtronik` (Owner mit
   BYPASSRLS); die App verbindet als `taxtronik_app` (eingeschränkt, RLS
   greift). Beide URLs in ENV (`DATABASE_URL`, `DATABASE_APP_URL`).

## Konsequenzen

**Positiv**

- Vergessener App-Filter wird durch RLS abgefangen — App-Role sieht NICHTS,
  wenn Tenant-Kontext fehlt (statt fremder Daten zu leaken).
- Vergessene RLS-Policy auf neuer Tabelle wird durch CI-Cross-Tenant-Test
  erkannt (siehe Verifikation).
- CLI/Worker-System-Jobs nutzen `withSystemContext(tenantId, ...)` — derselbe
  Mechanismus, dokumentiert.

**Negativ**

- Jede DB-Operation MUSS durch den Wrapper. Direkter `prisma.x.findMany()`
  ohne Wrapper liefert leeres Ergebnis (für die App-Role) — anfangs irritierend,
  langfristig sicher.
- Pro DB-Aufruf eine Transaktion (auch lesend). Performance-Overhead messbar
  bei Hot-Paths — Mitigation: Batching im Server-Code, nicht Aufgabe der DB.

## Alternativen

- **Nur App-Level**: verworfen — zu fragil, § 203 StGB.
- **Nur RLS**: verworfen — Pagination/Joins zu unbequem, kein expliziter
  Schutz vor falschem Cross-Tenant-Lookup.
- **Schema pro Mandant**: verworfen — Migrations-Hölle, skaliert nicht;
  unsere Multi-Tenancy ist ohnehin meist 1:1 (On-Prem pro Kanzlei).

## Verifikation

Pflicht-Test in CI (`packages/db/src/__tests__/rls-cross-tenant.test.ts`,
folgt in Iter. 1):

> Öffne zwei Sessions mit unterschiedlichen `tenant_id`. Versuche aus Session A
> auf Daten von Tenant B zuzugreifen (`SELECT`, `INSERT`, `UPDATE`). Erwartung:
> SELECT liefert leer, INSERT/UPDATE liefert Constraint-Violation.

Test MUSS rot werden, wenn auf einer neuen Tabelle die RLS-Policy vergessen wurde.
