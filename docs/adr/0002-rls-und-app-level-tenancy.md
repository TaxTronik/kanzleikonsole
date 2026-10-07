# ADR 0002 — Doppelte Verteidigung: RLS + App-Level-Tenancy

**Status**: Akzeptiert; Rollenmodell am 2026-10-06 präzisiert (Review-Befund S-01)
**Datum**: 2026-05-10 · aktualisiert 2026-10-06

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

3. **Rollenmodell** (präzisiert 2026-10-06, Review-Befund S-01):
   - `taxtronik` ist Superuser und Eigentümer aller Objekte. Ihn nutzen nur
     die Postgres-Initialisierung, der `migrate`-Container (DDL, Grants) und
     die Host-Werkzeuge der Operator-CLI (Backup vor Migrationen, Restore,
     `psql`).
   - `taxtronik_app` (`DATABASE_APP_URL`, ohne BYPASSRLS) bedient den
     App-Client: `withTenantContext`/`withSystemContext`, RLS greift.
   - `taxtronik_owner` (`DATABASE_URL` von app und worker) bedient den
     Owner-Client `prismaOwner`: BYPASSRLS für Pfade ohne Tenant-Kontext, aber
     ohne SUPERUSER, CREATEDB, CREATEROLE und REPLICATION. Die Rolle darf Daten
     lesen und schreiben (SELECT/INSERT/UPDATE/DELETE, Sequenzen, dieselben
     EXECUTE-Rechte wie die App-Rolle), aber keine DDL, kein TRUNCATE, kein
     `COPY … PROGRAM` und keine Trigger abschalten. `audit_log`, `audit_seal`
     und `audit_anchor` darf sie nur lesen und anfügen, `audit_archive` nicht
     löschen, `_prisma_migrations` nur lesen. Was bisher stillschweigend am
     Superuser hing, kapselt eine SECURITY-DEFINER-Funktion mit festem
     `search_path` (`app.purge_tax_deadline_request_links`).
   - `taxtronik_drill` (`DATABASE_DRILL_URL`, nur worker) legt für den
     monatlichen Restore-Drill Wegwerf-Datenbanken an (CREATEDB + BYPASSRLS)
     und hat in der Produktiv-DB keine Tabellenrechte.

   Rechte und Default-Privilegien vergibt die Migration
   `20261006160000_owner_role_least_privilege`; LOGIN und Passwörter setzt die
   Operator-CLI aus `.env` (`TAXTRONIK_OWNER_PASSWORD`,
   `TAXTRONIK_DRILL_PASSWORD`). `./taxtronik doctor` meldet eine fehlende oder
   falsch konfigurierte Rolle und einen Superuser in der Verbindung von app
   oder worker als Fehler.

## Konsequenzen

**Positiv**

- Vergessener App-Filter wird durch RLS abgefangen — App-Role sieht NICHTS,
  wenn Tenant-Kontext fehlt (statt fremder Daten zu leaken).
- Vergessene RLS-Policy auf neuer Tabelle wird durch CI-Cross-Tenant-Test
  erkannt (siehe Verifikation).
- System-Pfade mit bekanntem Tenant können `withSystemContext(tenantId, ...)`
  nutzen — derselbe Mechanismus über die App-Rolle (z. B. GwG-Onboarding,
  Worker-Job `expansion`).
- Codeausführung oder SQL-Injection auf einem Owner-Pfad führt nicht mehr zur
  Kontrolle über den Datenbankcluster: keine Schemaänderung, keine
  Rechteausweitung, keine Shell auf dem DB-Server (`COPY … PROGRAM`), keine
  Abschaltung der Audit-Trigger.

**Negativ**

- Pfade vor jedem Tenant-Kontext (Login, Token-Flows, Credential-Prüfung der
  n8n-Callbacks, Tenant-Auflösung des iCal-Feeds), mandantenübergreifende
  Tenant-Listen und die Wartungsjobs laufen weiter über den Owner-Client. Über
  diese Pfade erreicht ein Angreifer weiterhin alle Mandantendaten
  (BYPASSRLS); vor fehlenden Tenant-Filtern schützt hier nur der Code. Seit
  der S-01-Folgearbeit laufen dagegen die mandantenbezogenen Worker-Jobs, die
  n8n-Callbacks nach der Credential-Prüfung und der iCal-Feed nach der
  Tenant-Auflösung über die App-Rolle (`withSystemContext`); die verbleibenden
  Owner-Pfade und das Restrisiko führt das Threat Model
  (`docs/assurance/threat-model.md`, Datenbankrollen).

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
- **Owner-Verbindung als Superuser** (Stand bis 2026-10-06): verworfen nach
  Review-Befund S-01 — eine Lücke auf einem Owner-Pfad bedeutete volle
  Kontrolle über den Cluster.
- **Alle Owner-Pfade sofort auf die App-Rolle**: nicht in einem Schritt
  möglich (Login vor dem Tenant-Kontext, mandantenübergreifende Wartung);
  mandantenbezogene Worker-Jobs und Callbacks schrittweise auf
  `withSystemContext` umzustellen bleibt ein Folgepunkt.
- **Eigene Backup-Rolle für `pg_dump`**: verworfen — `pg_dump` braucht nur
  SELECT und BYPASSRLS, beides hat `taxtronik_owner`; der Dump ist mit dem des
  Superusers identisch.
- **CREATEDB für die Owner-Rolle** (Restore-Drill): verworfen — die eigene
  Rolle `taxtronik_drill` hat keine Rechte in der Produktiv-DB.

## Verifikation

Pflicht-Test in CI (`packages/db/src/__tests__/rls-cross-tenant.test.ts`,
folgt in Iter. 1):

> Öffne zwei Sessions mit unterschiedlichen `tenant_id`. Versuche aus Session A
> auf Daten von Tenant B zuzugreifen (`SELECT`, `INSERT`, `UPDATE`). Erwartung:
> SELECT liefert leer, INSERT/UPDATE liefert Constraint-Violation.

Test MUSS rot werden, wenn auf einer neuen Tabelle die RLS-Policy vergessen wurde.
