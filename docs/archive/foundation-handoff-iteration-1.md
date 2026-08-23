# Historischer Handoff — Foundation und Iteration 1

> **Historisches Archiv, nicht als Setup-, Aufgaben- oder Abnahmeanleitung
> verwenden.** Die nachfolgenden Pfade, Stubs und „nächsten Schritte" bilden
> Iteration 1 ab und sind teilweise bewusst vom heutigen Code überholt.
> Diese Datei wurde aus `docs/HANDOFF.md` ins Archiv verschoben. Aktueller
> Einstieg: [Projekt-README](../../README.md),
> [Funktionsumfang](../../FEATURES.md), [Architektur](../architecture.md) und
> [Operations](../operations/day-2-operations.md).

Diese Datei dokumentiert den ursprünglichen Foundation-Aufbau und verbleibende
Orientierungspunkte. Aktuelle Betriebs-, Feature- und Architektur-Doku steht in
`README.md`, `FEATURES.md`, `docs/architecture.md` und `docs/operations/`.

## Was schon steht (Foundation, Iter. 1 — kritische Dateien)

| Datei                                                                     | Status | Zweck                                                     |
| ------------------------------------------------------------------------- | ------ | --------------------------------------------------------- |
| `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json` | Fertig | Monorepo-Skelett                                          |
| `.env.example`, `.gitignore`, `.prettierrc`, `.editorconfig`, `.nvmrc`    | Fertig | Repo-Config                                               |
| `infra/compose/docker-compose.yml` + `docker-compose.dev.yml`             | Fertig | Stack: Postgres, Redis, SeaweedFS, ClamAV (+ Mailhog dev) |
| `infra/scripts/postgres-init.sql`                                         | Fertig | DB-Extensions, App-Role                                   |
| `infra/scripts/init-storage.sh`                                           | Fertig | Buckets mit Object-Lock                                   |
| `packages/db/prisma/schema.prisma`                                        | Fertig | Iter. 1 Datenmodell                                       |
| `packages/db/prisma/migrations/.../migration.sql`                         | Fertig | Initiale Migration mit RLS, Triggern, GwG-Schranke (Stub) |
| `packages/db/src/{client,tenant-context,index}.ts`                        | Fertig | Prisma-Client + RLS-Wrapper                               |
| `packages/config/src/env.ts`                                              | Fertig | Zod-validiertes ENV                                       |
| `packages/evidence/src/{service,canonical-json,ports/timestamp}.ts`       | Fertig | Hash-Chain + RFC-3161-Adapter                             |
| `packages/evidence/src/cli/verify.ts`                                     | Fertig | `pnpm verify:chain`                                       |
| `apps/web/{package.json,tsconfig.json,next.config.mjs,next-env.d.ts}`     | Fertig | Next.js-Setup                                             |
| `apps/web/src/middleware.ts`                                              | Fertig | Auth-Surface-Routing + Tenant-Header                      |
| `docs/architecture.md`, `docs/adr/{0001,0002,0003}.md`                    | Fertig | Doku                                                      |

## Historischer Iteration-1-Plan — nicht heute ausführen

### Schritt 1: Stack zum Laufen bringen

```bash
pnpm install
docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.dev.yml up -d
# Warte auf SeaweedFS-Init-Container (legt Buckets an):
docker compose -f infra/compose/docker-compose.yml logs seaweedfs-init
# Generate Prisma-Client:
pnpm db:generate
# Migration anwenden (legt Tabellen, RLS, Trigger an):
pnpm db:migrate:deploy
```

Erwartet: Postgres lauschend auf 5432, SeaweedFS-Master auf <http://localhost:9333>,
Buckets `gobd`/`gwg` (Object-Lock), `general`, `staff-private`, `backups` existieren.

### Schritt 2: Auth.js v5 Setup

Datei: `apps/web/src/server/auth/staff.ts`

- Auth.js v5 mit **Credentials-Provider** für Staff.
- Bei `authorize()`: lookup in `staff_user` per E-Mail + tenant_id (Tenant aus Header).
- `bcrypt`-Vergleich für Passwort (12 Rounds).
- TOTP-Pflicht: nach erstem Login `totp_secret_enc` setzen, Folgelogins erfordern TOTP-Code.
- Session: JWT-Strategy (keine Session-Tabelle nötig).
- Cookie-Name aus `session-cookie.ts`: in Production `__Host-taxtronik_staff_session`
  (ohne `STAFF_COOKIE_DOMAIN`; mit gesetzter Domain `__Secure-taxtronik_staff_session`,
  da `__Host-` kein Domain-Attribut erlaubt), im Dev (HTTP) `__taxtronik_staff_session`;
  `path: '/'`.
- TOTP-Secret-Verschlüsselung: AES-256-GCM mit per-Tenant-abgeleitetem Key (z. B. HKDF aus
  `AUTH_SECRET` + `tenant_id`).

Datei: `apps/web/src/server/auth/portal.ts`

- Iter. 2 (Magic-Link). Im Iter. 1 noch leer lassen oder Stub zurückgeben.

### Schritt 3: Composition-Root und Service-Verdrahtung

Datei: `apps/web/src/server/container.ts`

```ts
import { env } from '@taxtronik/config';
import { EvidenceService, LocalTimestampAdapter, Rfc3161StubAdapter } from '@taxtronik/evidence';
// ... Storage-Service (kommt mit @taxtronik/storage), Mail, etc.

const timestampPort = env.TIMESTAMP_AUTHORITY_URL
  ? new Rfc3161StubAdapter(env.TIMESTAMP_AUTHORITY_URL)
  : new LocalTimestampAdapter();

export const services = {
  evidence: new EvidenceService(timestampPort),
  // storage, mail, ...
};
```

### Schritt 4: Erste UI-Seiten

- `apps/web/src/app/layout.tsx` — Root-Layout, Tailwind, Schriften, Provider.
- `apps/web/src/app/(staff)/layout.tsx` — Staff-Sidebar.
- `apps/web/src/app/(staff)/login/page.tsx` — Mitarbeiter-Login (Form + TOTP-Step).
- `apps/web/src/app/(staff)/dashboard/page.tsx` — Dashboard-Stub.
- `apps/web/src/app/(staff)/clients/page.tsx` — Mandantenliste.
- `apps/web/src/app/(staff)/clients/new/page.tsx` — Mandant anlegen.
- `apps/web/src/app/(staff)/clients/[id]/page.tsx` — Mandanten-Detail mit Dokumenten-Tab.
- `apps/web/src/app/api/health/route.ts` — Health-Endpoint (DB/Redis/SeaweedFS/ClamAV).

shadcn/ui für Komponenten (`pnpm dlx shadcn@latest init` im `apps/web`-Workspace).

### Schritt 5: Storage-Service (`packages/storage`)

- S3-Client (`@aws-sdk/client-s3` mit `forcePathStyle: true`).
- Presigned-PUT für Browser-Upload.
- Commit-Endpoint: lädt Datei kurz, scannt mit ClamAV (TCP), berechnet SHA-256,
  schreibt `document` + `document_version` (mit `immutable: true` für GoBD-Klassen).
- Retention: für GoBD-Klassen dokumenttypabhängig 6, 8 oder 10 Jahre ab dem
  einschlägigen Jahresende und Object-Lock-Retain; Rechnungen werden acht Jahre aufbewahrt.

### Schritt 6: Cross-Tenant-RLS-Test

Datei: `packages/db/src/__tests__/rls-cross-tenant.test.ts` (Vitest).

- Setup: Erstelle 2 Tenants mit je 1 Client und 1 Document.
- Test 1: `withTenantContext({tenantId: A, ...})` darf NICHT Client von B sehen.
- Test 2: Direktes `prisma.client.findMany()` ohne Wrapper → liefert leeres Array
  (App-Role + RLS).
- Test 3: Versuch `tx.client.update` auf Cross-Tenant-Client → wirft
  Constraint-Violation.

Pflicht in CI.

## Iteration 2+

Die ursprünglichen Iterationsnotizen sind in der Repo-Doku, den ADRs und den
aktuellen Issues konsolidiert. Neue Arbeiten sollten an diesen Quellen und der
vorhandenen Foundation ausgerichtet werden.

## Historische Leitplanken

1. **n8n statt Eigencode** für Kommunikation/Reminder/Cron, wo immer möglich.
2. **Externe APIs (DATEV/Transparenzregister/ELSTER) NICHT im MVP** — nur
   Excel-/PDF-Importpfade. API-Anbindung erst, wenn der Prozess steht.
3. **Manipulationsevidenz ist SHA-256 + Hash-Chain + RFC-3161** — keine
   Blockchain, keine Over-Engineering.
4. **Jede DB-Operation MUSS durch `withTenantContext`** — sonst RLS-Block.
5. **Sprache des Users ist Deutsch** — UI, Doku, Commit-Messages auf Deutsch.

## Historische Abnahme für Iteration 1

Wenn folgende Checks grün sind, ist Iter. 1 fertig:

```bash
# 1. Stack startet
docker compose -f infra/compose/docker-compose.yml up -d
pnpm install
pnpm db:migrate:deploy
pnpm db:seed
pnpm dev
# → http://localhost:3000 lädt

# 2. Mitarbeiter-Login via Seed funktioniert (mit TOTP-Setup beim ersten Login)

# 3. Mandant anlegen via UI funktioniert; audit_log enthält Eintrag
psql -U taxtronik -d taxtronik -c "SELECT id, action, encode(this_hash, 'hex') FROM audit_log;"

# 4. Dokument-Upload via UI: Datei landet in SeaweedFS, audit_log-Eintrag, document_version mit sha256

# 5. Cross-Tenant-RLS-Test grün
pnpm --filter @taxtronik/db test

# 6. Hash-Chain-Verifikation
pnpm verify:chain
# → "✓ Kette intakt" für jeden Tenant
```
