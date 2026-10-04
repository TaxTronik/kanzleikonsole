// Fachkatalog: ACCESS-NOTIFICATION-RECIPIENT-001
// Fachkatalog: ACCESS-TENANT-RLS-001
// Fachkatalog: DOC-PORTAL-SHARING-001
// Fachkatalog: MANDATE-STRUCTURE-001
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';

// `id::TEXT = p_resource_id` schaltet Primärschlüssel- und Unique-Index ab.
// Die Policies rufen diese Funktionen je gelesener Zeile auf; ein Text-Vergleich
// macht aus jeder Prüfung einen Scan über alle Tenant-Zeilen der Zieltabelle.
const TEXT_ID_COMPARISON = /\b(?:id|document_id)::text\s*=\s*(?:p_resource_id|did)\b/i;
const LOOKUP_FUNCTIONS = [
  'app.notification_resource_scope(uuid,text,text)',
  'app.mandate_artifact_document_allowed(uuid,text)',
  'app.document_payroll_scope_allowed(uuid,text)',
] as const;

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20261004120000_rls_resource_uuid_lookup/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
// Der Kopfkommentar zitiert das alte Muster; geprüft wird nur ausführbares SQL.
const migrationSql = migration.replace(/--.*$/gm, '');

describe('RLS-Ressourcensuche per UUID: Migration', () => {
  it('definiert alle Lookup-Funktionen ohne Text-Vergleich der ID neu', () => {
    for (const signature of LOOKUP_FUNCTIONS) {
      const name = signature.slice(0, signature.indexOf('('));
      expect(migrationSql).toContain(`CREATE OR REPLACE FUNCTION ${name}(`);
    }
    expect(migrationSql).not.toMatch(TEXT_ID_COMPARISON);
  });

  it('akzeptiert im Helfer nur die kanonische Textform von uuid', () => {
    expect(migrationSql).toContain(
      "p_value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'",
    );
    expect(migrationSql).toMatch(
      /REVOKE ALL ON FUNCTION app\.canonical_uuid_or_null\(TEXT\) FROM PUBLIC;/,
    );
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('RLS-UUID-Lookup-Test braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

let tenantId: string;
let staffId: string;
let clientId: string;
let documentId: string;

type Scope = {
  resource_is_known: boolean;
  resource_was_found: boolean;
  resolved_client_id: string | null;
};

async function asStaff<T>(work: (tx: TxClient) => Promise<T>): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT
        set_config('app.current_tenant_id', ${tenantId}, true),
        set_config('app.current_actor_id', ${staffId}, true),
        set_config('app.current_actor_type', 'STAFF', true)
    `;
    return work(tx);
  });
}

function scope(resourceType: string, resourceId: string | null): Promise<Scope | undefined> {
  return asStaff(async (tx) => {
    const rows = await tx.$queryRaw<Scope[]>`
      SELECT resource_is_known, resource_was_found, resolved_client_id
        FROM app.notification_resource_scope(${tenantId}::uuid, ${resourceType}, ${resourceId})
    `;
    return rows[0];
  });
}

beforeAll(async () => {
  if (!hasDatabase) return;
  const seed = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  tenantId = (
    await owner.tenant.create({ data: { name: 'UUID-Lookup', slug: `uuid-lookup-${seed}` } })
  ).id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `uuid-lookup-${seed}@example.test`,
        fullName: 'UUID-Lookup',
        passwordHash: 'synthetic',
        roles: { create: { role: 'ADMIN' } },
      },
    })
  ).id;
  clientId = (
    await owner.client.create({ data: { tenantId, kind: 'NATPERS', name: 'UUID-Lookup-Mandant' } })
  ).id;
  // Internes Dokument: Mandantendokumente setzen eine bestandene GwG-Schranke voraus.
  documentId = (
    await owner.document.create({
      data: {
        tenantId,
        ownerStaffId: staffId,
        title: 'UUID-Lookup-Dokument',
        classification: 'GENERAL',
        mimeType: 'application/pdf',
      },
    })
  ).id;
});

afterAll(async () => {
  if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describeWithDatabase('RLS-Ressourcensuche per UUID: Datenbank', () => {
  it('enthält im aktuellen Funktionsstand keinen Text-Vergleich der ID', async () => {
    for (const signature of LOOKUP_FUNCTIONS) {
      const rows = await owner.$queryRaw<Array<{ definition: string }>>`
        SELECT pg_catalog.pg_get_functiondef(${signature}::regprocedure) AS definition
      `;
      expect(rows[0]?.definition, signature).not.toMatch(TEXT_ID_COMPARISON);
    }
  });

  it('wandelt nur die kanonische Textform in eine uuid', async () => {
    const canonical = documentId.toLowerCase();
    const rows = await owner.$queryRaw<Array<{ input: string | null; value: string | null }>>`
      SELECT input, app.canonical_uuid_or_null(input)::text AS value
        FROM unnest(ARRAY[
          ${canonical},
          upper(${canonical}),
          '{' || ${canonical} || '}',
          replace(${canonical}, '-', ''),
          ${canonical} || ' ',
          '12345',
          '',
          NULL
        ]::text[]) AS input
    `;
    expect(rows.map((row) => row.value)).toEqual([
      canonical,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('löst Ressourcen wie bisher nur über die kanonische ID auf', async () => {
    await expect(scope('document', documentId)).resolves.toEqual({
      resource_is_known: true,
      resource_was_found: true,
      resolved_client_id: null,
    });
    await expect(scope('client', clientId)).resolves.toEqual({
      resource_is_known: true,
      resource_was_found: true,
      resolved_client_id: clientId,
    });
    await expect(scope('document', documentId.toUpperCase())).resolves.toEqual({
      resource_is_known: true,
      resource_was_found: false,
      resolved_client_id: null,
    });
  });

  it('verarbeitet Nicht-UUID-IDs ohne Cast-Fehler', async () => {
    // audit_log-Hinweise tragen BIGINT-IDs als Text.
    await expect(scope('audit_log', '12345')).resolves.toEqual({
      resource_is_known: true,
      resource_was_found: true,
      resolved_client_id: null,
    });
    await expect(scope('document', '12345')).resolves.toEqual({
      resource_is_known: true,
      resource_was_found: false,
      resolved_client_id: null,
    });
    const allowed = await asStaff(
      (tx) => tx.$queryRaw<Array<{ artifact: boolean; payroll: boolean }>>`
        SELECT app.mandate_artifact_document_allowed(${tenantId}::uuid, '12345') AS artifact,
               app.document_payroll_scope_allowed(${tenantId}::uuid, '12345') AS payroll
      `,
    );
    expect(allowed[0]).toEqual({ artifact: true, payroll: true });
  });

  it('liefert das Dokument über die unveränderten Policies weiter aus', async () => {
    const found = await asStaff((tx) => tx.document.findUnique({ where: { id: documentId } }));
    expect(found?.id).toBe(documentId);
  });
});
