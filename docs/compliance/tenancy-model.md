# Tenancy-Modell und Tenant-Isolation

Stand: 2026-05-14

Dieses Dokument klärt die Tenant-Trennung in taxtronik — was die DB-Schicht
garantiert, was die App-Schicht beitragen muss und welche Designkompromisse
das aktuelle Multi-Tenant-Verhalten einschränken.

---

## Designentscheidung: On-Premise-Single-Tenant first

taxtronik ist primär für **On-Premise-Installationen einer einzelnen
Steuerberater-Kanzlei** konzipiert. Multi-Tenant-Hosting (SaaS, mehrere
Kanzleien auf einer Installation) ist technisch möglich, aber an mehreren
Stellen mit eingeschränktem Funktionsumfang:

| Pfad | Verhalten | Single-Tenant | Multi-Tenant |
|---|---|---|---|
| Magic-Link-URL | `NEXTAUTH_URL` ist global | ✓ | ✗ Alle Kanzleien teilen sich eine URL |
| `TaxNewsItem` | Cache ohne `tenant_id` (S-3) | ✓ Geteilter Feed-Cache spart Worker | ⚠ Tenants sehen denselben Cache (jeder filtert per `source IN active_urls`, aber DB-direkt-Zugriff sieht alles) |
| Subdomain-Tenancy | `extractTenantSlug` in [`proxy.ts`](../../apps/web/src/proxy.ts) ist implementiert | ungenutzt | aktiv |
| Update-Manifest | Eine globale Signatur, ein globaler Public-Key | ✓ | ✓ — aber Update-Schritt erfordert dann Operator-Koordination |

> **Empfehlung für Operator**: Wenn der Use-Case Multi-Tenant erfordert,
> Installation pro Kanzlei separieren (eigene Docker-Compose, eigene
> DB-Instanz). Das ist auch berufsrechtlich (§ 203 StGB Mandatsgeheimnis)
> die sauberere Trennung.

## Tenant-Trennung — drei Verteidigungslinien

### 1. Postgres Row-Level Security (RLS)

- Jede mandantenbezogene Tabelle hat eine RLS-Policy `tenant_id = app.current_tenant_id()`.
- Die App-Rolle (`taxtronik_app`, ohne BYPASSRLS) sieht ohne gesetzten
  Session-Context **nichts**. Vergessene Tenant-Filter sind so DB-seitig
  abgefangen.

### 2. `withTenantContext` / `withSystemContext`

- App-Code nutzt diese Wrapper aus `@taxtronik/db`, um den RLS-Context
  innerhalb einer Transaktion zu setzen.
- Worker-Code nutzt `withWorkerTenantContext` (das prismaOwner-äquivalent).

### 3. Application-Layer-Filter (`tenantId: session.user.tenantId`)

- Jede Query passt explizit `WHERE tenant_id = ?` — Defense-in-Depth.

## `prismaOwner` (BYPASSRLS) — kontrollierter Einsatz

`prismaOwner` aus `apps/web/src/server/db/prisma-owner.ts` und
`packages/db/src/owner-client.ts` (T-1) hat **BYPASSRLS** und ist für Pfade
gedacht, die RLS nicht sinnvoll nutzen können:

1. **Auth-Flow vor Tenant-Context** — Login-Endpoints können noch keinen
   Session-Tenant haben.
2. **Cross-Tenant-Verifikation** — z. B. `pnpm verify:chain`.
3. **System-Wartung** — Backup-Runner, Reconcile-Worker.

**Aktuelle Verwendung**: ~17 Stellen. Jede ist ein expliziter Code-Pfad
ohne RLS-Schutz und muss eigenverantwortlich tenantId-filtern.

### Code-Review-Checkliste für neue prismaOwner-Nutzung

- [ ] Gibt es einen handfesten Grund, nicht `withTenantContext` zu nehmen?
      (Login-Pfad, System-Job, expliziter Cross-Tenant-Use-Case)
- [ ] Falls Tenant-Scope: ist `tenantId` explizit in der `where`-Klausel?
      Mehrere `findMany`-Aufrufe in derselben Funktion sollten alle den
      gleichen Tenant filtern.
- [ ] Ist der Pfad in [`audit_log`](../../packages/db/prisma/schema.prisma)
      erkennbar (`actor_type=SYSTEM` oder `actor_id` gesetzt)?

### Geplante Härtung (Roadmap, nicht im MVP)

- **ESLint-Custom-Rule** `no-prisma-owner-outside-allowlist`: erlaubt
  `prismaOwner`-Import nur in einer explizit kuratierten Datei-Liste,
  blockt alle anderen Stellen. Reduziert Drift bei neuen Routes.
- **Tenant-Context-Required-Type**: `prismaOwner` returnt einen Typ, der
  nur über `assertCrossTenantUseCase('reason')`-Wrapper aufrufbar ist —
  zwingt Begründung im Code.

## Code-Duplikations-Ausgangspunkt SSRF/Crypto/Fetcher

Vorher gab es zwei parallele Kopien von SSRF-Guard, safeFetch und Crypto
in Web + Worker. Konsolidiert (Round 12):

- `@taxtronik/http-utils` — assertPublicHost, safeFetch (von H1/N1/N6)
- `@taxtronik/crypto` — secret-box v1/v2 (M-1)
- `@taxtronik/db` — prismaOwner-Singleton + tenant-context (T-1)

RSS-Fetcher bleibt vorerst dupliziert (Worker hat eigene Kopie für den
täglichen Schedule, Web hat eine on-demand-Variante). Beide nutzen jetzt
denselben `safeFetch` aus `@taxtronik/http-utils`.
