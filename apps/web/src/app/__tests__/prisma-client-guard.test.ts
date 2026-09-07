// =============================================================================
// DB-Guard: jede PrismaClient-Instanz im Monorepo ist bewusst freigegeben
//
// Hintergrund (Security-Review, § 203 StGB): Der App-Request-Pfad MUSS über
// den RLS-gefilterten App-Client (packages/db client.ts → resolveAppDatasourceUrl
// → withTenantContext) laufen. Ein frei im Code instanziierter `new PrismaClient`
// kann versehentlich die Owner-Verbindung (BYPASSRLS) nutzen oder den
// Tenant-Kontext-Wrapper umgehen — beides hebelt die Mandantentrennung aus.
//
// Dieser Test scannt apps/ und packages/ nach `new PrismaClient` und vergleicht
// die Treffer mit einer Allowlist bewusst freigegebener Stellen. Taucht eine
// NEUE Datei auf, schlägt der Test an und zwingt zur Entscheidung:
//   - Owner-/System-Client (Migration, Worker-Job, Backup, Seed, Test)?
//     → mit Begründung in ALLOWED_PRISMA_CLIENT_FILES eintragen.
//   - App-Request-Pfad? → KEIN eigener Client. prisma + withTenantContext
//     aus @taxtronik/db verwenden.
// =============================================================================

import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../../../');
const SCAN_DIRS = ['apps', 'packages'];
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
]);
// Toleriert beliebigen Whitespace (`new  PrismaClient`, Zeilenumbruch) zwischen
// `new` und `PrismaClient`, damit ungewöhnliche Formatierung den Guard nicht
// aushebelt. PrismaClientCtor ist der Alias fuer den zentralen Interop-Adapter.
const NEEDLE = /\bnew\s+PrismaClient(?:Ctor)?\b/;
// Dieser Guard erwähnt NEEDLE in Kommentaren/Meldungen, instanziiert aber
// keinen Client — sich selbst nicht als Treffer werten.
const SELF = 'apps/web/src/app/__tests__/prisma-client-guard.test.ts';

// Bewusst freigegebene Stellen (repo-relativ, Forward-Slashes). Jede ist KEIN
// App-Request-Pfad-Client.
const ALLOWED_PRISMA_CLIENT_FILES = new Set<string>([
  // ACCESS-TENANT-RLS-001 / AUDIT-HASH-CHAIN-001: isolated restore-target
  // probes and deliberately unsafe privilege fixtures that always roll back.
  'packages/db/src/__tests__/restore-security.test.ts',
  // New workflow/notice/campaign policies are exercised with isolated owner
  // fixtures and a separate non-owner application connection.
  'packages/db/src/__tests__/workflow-expansion.test.ts',
  // WORKFLOW-DEPENDENCY-001: isolated owner fixtures and real application-role notification/period checks.
  'packages/db/src/__tests__/workflow-dependencies.test.ts',
  // WORKFLOW-LIFECYCLE-001: isolierte Owner-Fixtures und separate App-Rolle
  // beweisen konkurrierende Abschlüsse, Portaltrigger und Feedback-Atomarität.
  'packages/db/src/__tests__/workflow-lifecycle.test.ts',
  // Explicitly isolated expansion database: owner fixture, unchanged production services on the app role.
  'apps/web/src/server/mandate-expansion/__tests__/service-db.test.ts',
  // MAIL-INBOX-001: owner creates synthetic fixtures, app connection proves RLS.
  'packages/db/src/__tests__/mailbox-rls.test.ts',
  // PORTAL-INBOX-SUBMISSION-001: Owner erzeugt isolierte Fixtures; die
  // separate App-Verbindung beweist Kontakt-, Staff-, RLS- und Write-only-Grenzen.
  'packages/db/src/__tests__/portal-inbox-rls.test.ts',
  // MAIL-INBOX-001: isolated owner fixtures, real app transaction proves OAuth role/module revocation.
  'packages/db/src/__tests__/mailbox-oauth-cache.test.ts',
  // Isolated synthetic fixtures; assertions use the restricted App connection.
  'packages/db/src/__tests__/mandate-assistance-expansion.test.ts',
  'packages/db/src/__tests__/payroll-intake.test.ts',
  'packages/db/src/__tests__/screening-fees-rls.test.ts',
  // Der App-Client selbst — fail-closed via resolveAppDatasourceUrl.
  'packages/db/src/client.ts',
  // Owner-Verbindung (BYPASSRLS) ausschließlich für Migrationen/Verifikation.
  'packages/db/src/owner-client.ts',
  // Dev-Seed (NODE_ENV!=production erzwungen), Owner-Verbindung.
  'packages/db/seeds/dev.ts',
  // Production-Provisionierung (Tenant + Admin, keine Demodaten) — läuft als
  // Operator-CLI VOR dem ersten Login, Owner-Verbindung ist hier der Zweck.
  'packages/db/seeds/provision.ts',
  // Idempotente n8n-ACP-Provisionierung im Deploy — läuft als Operator-CLI
  // außerhalb jedes App-Requests und benötigt die systemweite Verbindung.
  'packages/db/seeds/provision-n8n.ts',
  // Production-Recovery-CLI: setzt ein bestehendes Admin-Passwort außerhalb
  // des App-Request-Pfads zurück; Owner-Verbindung ist hier bewusst nötig.
  'apps/web/scripts/reset-admin-password.ts',
  // RLS-Integrationstest konstruiert bewusst Owner- + App-Client.
  'packages/db/src/__tests__/rls-cross-tenant.test.ts',
  // GwG-Schranken-Test konstruiert einen Owner-Client fürs Setup.
  'packages/db/src/__tests__/gwg-allow-active.test.ts',
  // Dev-Seed-Regression: Owner-Client stellt ein altes unvollständiges
  // VERIFIED-Fragment her und beweist die fail-closed Reparaturreihenfolge.
  'packages/db/src/__tests__/dev-seed-gwg.test.ts',
  // Festschreibungs-Test (iter85): Owner-Client, um die Rechnungs-Trigger
  // GEGEN den privilegierten Pfad zu beweisen (Schutz gilt auch für Owner).
  'packages/db/src/__tests__/invoice-festschreibung.test.ts',
  // PoA-Signaturintegrität (iter108): Owner-Client beweist, dass Snapshot- und
  // Status-Trigger auch den privilegierten BYPASSRLS-Pfad schützen.
  'packages/db/src/__tests__/poa-signing-integrity.test.ts',
  // DB-Evidence-Regressionen: Owner-Clients prüfen Constraints/Trigger bewusst
  // auch gegen den privilegierten BYPASSRLS-Pfad.
  'packages/db/src/__tests__/dsgvo-evidence.test.ts',
  'packages/db/src/__tests__/gwg-destruction.test.ts',
  // Invite-Discard-Regression: Owner für Fixtures und App-Rolle für den
  // SECURITY-DEFINER-/RLS-Nachweis auf einer isolierten Testdatenbank.
  'packages/db/src/__tests__/gwg-onboarding-document-discard.test.ts',
  // GwG-Zuordnungsinvarianten: eigener Owner-Client gegen eine isolierte
  // Test-DB, damit auch direkte SQL-Umgehungsversuche geprüft werden.
  'packages/db/src/__tests__/gwg-identity-assignment.test.ts',
  // ACCESS-TENANT-RLS-001: isolierter Owner für Fixtures und separate App-
  // Verbindung zum Nachweis der WebAuthn-RLS- und Mindestschlüssel-Invarianten.
  'packages/db/src/__tests__/staff-webauthn-rls.test.ts',
  'packages/db/src/__tests__/tax-notice-evidence.test.ts',
  // TAX-MASTER-DATA-001: isolierte DB-Fixtures plus echte App-RLS-Grenzen.
  'packages/db/src/__tests__/tax-master-data.test.ts',
  // GWG-RISK-REVIEW-001: echte PostgreSQL-Reviewer-Locks mit isolierten Fixtures.
  'packages/db/src/__tests__/gwg-professional-lock.test.ts',
  // GWG-PERSON-LINKS-001: Owner-Fixtures beweisen Anchor-Constraints und Retention.
  'packages/db/src/__tests__/gwg-person-links.test.ts',
  // Neue Migrations-/RLS-Regressionen laufen gegen isolierte Wegwerf-DBs:
  // Owner legt die gezielten Race-/Legacy-Fixtures an, die App-Rolle beweist
  // anschließend die tatsächlichen CLIENT_CONTACT-/STAFF-Grenzen.
  'packages/db/src/__tests__/form-upload-discard-rls.test.ts',
  'packages/db/src/__tests__/gwg-id-document-request-lifecycle.test.ts',
  'packages/db/src/__tests__/gwg-open-first-check-retention.test.ts',
  'packages/db/src/__tests__/invoice-xrechnung-document-link.test.ts',
  // Integrationsbeweis fuer die deferrable TaxDeadline/Request-Pointer-Trigger:
  // Owner legt gezielt inkonsistente Mutationen vor; die App-Rolle prueft
  // separat die STAFF-/CLIENT_CONTACT-RLS auf internen Kommentaren.
  'packages/db/src/__tests__/tax-deadline-request-consistency.test.ts',
  // Tagesabschluss-Integration: Owner erzeugt isolierte Fixtures; App-Client
  // beweist RLS, Append-only-Snapshot, Datumskonsistenz und Tenant-Trennung.
  'packages/db/src/__tests__/deadline-daily-review.test.ts',
  // Notification-Client-Scope-RLS: Owner legt isolierte Fixtures an; die
  // App-Rolle beweist die CLIENT_CONTACT-/STAFF-Grenzen der neuen Scopes.
  'packages/db/src/__tests__/notification-client-scope-rls.test.ts',
  // Reminders-Daily-Source-Lock: Owner fuer Fixtures, App-Rolle als Beweis —
  // selbes Muster wie die uebrigen RLS-Regressionstests.
  'packages/db/src/__tests__/reminders-daily-source-lock.test.ts',
  // Backup-Restore-Probe — Admin-Operation gegen die Ziel-DB.
  'apps/web/src/server/backup/restore.ts',
  // Restore-Drill: eigener Client gegen die WEGWERF-DB taxtronik_drill
  // (Chain-Verifikation auf dem wiederhergestellten Stand) — bewusst kein
  // App-/Owner-Client, die zeigen auf die Produktiv-DB.
  'apps/worker/src/jobs/backup-drill.ts',
  // RLS-Drift-Gate: introspectiert pg_catalog für ENABLE/FORCE RLS + Policies.
  // Owner-Verbindung (BYPASSRLS), bewusst kein App-Request-Pfad.
  'packages/db/scripts/verify-rls.ts',
]);

function walk(dir: string, acc: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(resolve(dir, entry.name), acc);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      acc.push(resolve(dir, entry.name));
    }
  }
}

describe('PrismaClient-Guard — keine ungeprüften DB-Clients', () => {
  it('jede `new PrismaClient`-Stelle steht auf der Allowlist', () => {
    const files: string[] = [];
    for (const d of SCAN_DIRS) walk(resolve(REPO_ROOT, d), files);

    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      if (!NEEDLE.test(content)) continue;
      const rel = relative(REPO_ROOT, file).split(sep).join('/');
      if (rel === SELF) continue;
      if (!ALLOWED_PRISMA_CLIENT_FILES.has(rel)) offenders.push(rel);
    }

    expect(
      offenders,
      `Neue \`new PrismaClient\`-Instanz(en) gefunden:\n  ${offenders.join('\n  ')}\n\n` +
        'App-Request-Pfad? → KEIN eigener Client, sondern prisma + withTenantContext ' +
        'aus @taxtronik/db. Owner-/System-Client? → mit Begründung in ' +
        'ALLOWED_PRISMA_CLIENT_FILES eintragen.',
    ).toEqual([]);
  });

  it('Allowlist ist nicht verwaist (jede Datei existiert noch und nutzt PrismaClient)', () => {
    const stale: string[] = [];
    for (const rel of ALLOWED_PRISMA_CLIENT_FILES) {
      try {
        const content = readFileSync(resolve(REPO_ROOT, rel), 'utf-8');
        if (!NEEDLE.test(content)) stale.push(rel);
      } catch {
        stale.push(rel);
      }
    }
    expect(
      stale,
      `Allowlist-Einträge ohne \`new PrismaClient\` (umbenannt/gelöscht?) — bitte ` +
        `aus ALLOWED_PRISMA_CLIENT_FILES entfernen:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});

const OWNER_IMPORT = /import\s*\{[^}]*\bprismaOwner\b[^}]*\}\s*from\s*['"]([^'"]+)['"]/gs;

// Bewusst freigegebene Owner-Client-Importe. Neue Treffer muessen hier mit
// fachlicher Begruendung landen, damit BYPASSRLS-Nutzung nicht versehentlich in
// normale Request-Pfade rutscht.
const ALLOWED_PRISMA_OWNER_IMPORTS = new Set<string>([
  'apps/web/src/app/api/n8n/expiring-gwg-checks/route.ts <- @/server/db/prisma-owner',
  'apps/web/src/app/api/n8n/overdue-requests/route.ts <- @/server/db/prisma-owner',
  'apps/web/src/app/api/n8n/request-detail/[id]/route.ts <- @/server/db/prisma-owner',
  'apps/web/src/app/api/portal/ical/[token]/route.ts <- @/server/db/prisma-owner',
  'apps/web/src/app/audit-verify/[token]/page.tsx <- @/server/db/prisma-owner',
  'apps/web/src/app/gwg-onboarding/actions.ts <- @/server/gwg-onboarding/service',
  // Unauthentifizierte, token-basierte PoA-Signatur-Dokumentansicht (kein
  // Session-/Tenant-Kontext) — spiegelt loadPoaForSigning; liefert NUR das eine
  // per Token freigeschaltete Dokument (scoped auf poa.tenantId + poa.documentId).
  'apps/web/src/app/poa/sign/document/route.ts <- @/server/db/prisma-owner',
  'apps/web/src/app/portal/(auth)/login/actions.ts <- @/server/db/prisma-owner',
  'apps/web/src/app/staff/(auth)/login/actions.ts <- @/server/db/prisma-owner',
  'apps/web/src/app/staff/(auth)/login/password/route.ts <- @/server/db/prisma-owner',
  // Staff-Seite: nur noch typeof-Bezug (Rueckgabetyp von sendForSignature) —
  // kein Laufzeit-Bypass, der Import bleibt aber ein Wert-Import fuers typeof.
  'apps/web/src/app/staff/(protected)/poa/actions.ts <- @/server/db/prisma-owner',
  // Oeffentlicher Token-Sign-Flow (aus poa/actions.ts herausgeloest): kein
  // Session-/Tenant-Kontext, Lookup ausschliesslich ueber den Token-Hash —
  // dieselbe Begruendung wie zuvor fuer poa/actions.ts.
  'apps/web/src/app/staff/(protected)/poa/sign-actions.ts <- @/server/db/prisma-owner',
  'apps/web/src/server/auth/login-audit.ts <- @/server/db/prisma-owner',
  'apps/web/src/server/auth/magic-link.ts <- @/server/db/prisma-owner',
  'apps/web/src/server/auth/portal.ts <- @/server/db/prisma-owner',
  'apps/web/src/server/auth/staff.ts <- @/server/db/prisma-owner',
  // Benutzerloser Hardware-Login hat vor der Assertion-Verifikation noch
  // keinen vertrauenswürdigen Tenant-Kontext. Der globale Credential-Lookup
  // wird anschließend kryptografisch, per userHandle und Konto-Tenant gebunden.
  'apps/web/src/server/auth/webauthn.ts <- @/server/db/prisma-owner',
  'apps/web/src/server/backup/restore.ts <- @/server/db/prisma-owner',
  'apps/web/src/server/backup/runner.ts <- @/server/db/prisma-owner',
  // Dev-only Retention/Object-Lock-Fixtures; verweigert NODE_ENV=production.
  'apps/web/src/server/demo/retention-fixtures.ts <- @/server/db/prisma-owner',
  // Kompensationsjournal nach bereits erfolgreichem Object-Storage-Commit:
  // der urspruengliche Tenant-Tx kann fehlgeschlagen oder sein ACK mehrdeutig
  // sein. Der Owner-Pfad schreibt ausschliesslich den tenantgebundenen
  // StorageOrphan-Recoverydatensatz; er liest oder liefert keine Mandantendaten.
  'apps/web/src/server/documents/storage-compensation.ts <- @/server/db/prisma-owner',
  'apps/web/src/server/gwg-onboarding/service.ts <- @/server/db/prisma-owner',
  // Einmaliger Operator-Cutover: SQL-Migrationsmarker tenantübergreifend lesen
  // und idempotent auditieren. Kein Request-Import, keine externen Nachrichten.
  'apps/web/src/server/gwg-onboarding/migrate-invite-v2-audit.ts <- @/server/db/prisma-owner',
  'apps/web/src/server/license/state.ts <- @/server/db/prisma-owner',
  // Externe n8n-Callbacks haben vor der Credential-Pruefung noch keinen
  // vertrauenswuerdigen Tenant-Kontext. Der Owner-Lookup bindet Key-ID an
  // Connection/Tenant; Operations und Crash-Recovery scopen danach jeden
  // Zugriff explizit auf den authentifizierten tenantId/connectionId.
  'apps/web/src/server/n8n/callback-auth.ts <- @/server/db/prisma-owner',
  'apps/web/src/server/n8n/callback-receipts.ts <- @/server/db/prisma-owner',
  'apps/web/src/server/n8n/operations.ts <- @/server/db/prisma-owner',
  'apps/web/src/server/n8n/outbox.ts <- @/server/db/prisma-owner',
  'apps/web/src/server/risk/research.ts <- @/server/db/prisma-owner',
  'apps/web/src/server/settings/legal.ts <- @/server/db/prisma-owner',
  // readBrandingForSlug: oeffentlicher Reader fuer die Login-Seiten (Staff +
  // Portal) — vor der Session gibt es keinen Tenant-Kontext; liefert nur
  // Anzeige-Name/Akzentfarbe/Logo-Data-URLs des per Slug adressierten Tenants
  // (Muster: readLegalForSlug in legal.ts).
  'apps/web/src/server/settings/branding.ts <- @/server/db/prisma-owner',
  'apps/web/src/server/tax-news/fetcher.ts <- @/server/db/prisma-owner',
]);

describe('prismaOwner-Guard - BYPASSRLS-Importe bleiben explizit', () => {
  it('jeder prismaOwner-Import steht auf der Allowlist', () => {
    const files: string[] = [];
    walk(resolve(REPO_ROOT, 'apps/web/src'), files);

    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const rel = relative(REPO_ROOT, file).split(sep).join('/');
      for (const match of content.matchAll(OWNER_IMPORT)) {
        const source = match[1]!;
        const key = `${rel} <- ${source}`;
        if (!ALLOWED_PRISMA_OWNER_IMPORTS.has(key)) offenders.push(key);
      }
    }

    expect(
      offenders,
      `Neue prismaOwner-Importe gefunden:\n  ${offenders.join('\n  ')}\n\n` +
        'Normale mandantenbezogene Pfade muessen prisma + withTenantContext nutzen. ' +
        'Owner-Pfad wirklich noetig? Dann mit Begruendung in ALLOWED_PRISMA_OWNER_IMPORTS aufnehmen.',
    ).toEqual([]);
  });
});
