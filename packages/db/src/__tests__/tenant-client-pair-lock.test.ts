// Fachkatalog: ACCESS-TENANT-RLS-001
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20261004121000_tenant_client_pair_key_share_lock/migration.sql',
    import.meta.url,
  ),
  'utf8',
).replace(/--.*$/gm, '');

describe('Paar-Guard-Sperre: Migration', () => {
  it('sperrt den Mandanten nur noch mit FOR KEY SHARE', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION app.enforce_tenant_client_pair_integrity()',
    );
    expect(migration).toMatch(/\bFOR KEY SHARE;/);
    expect(migration).not.toMatch(/\bFOR SHARE\b/);
    expect(migration).toContain('SET search_path = pg_catalog, public, app, pg_temp');
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Paar-Guard-Sperrtest braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const holder = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const other = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId: string;
let staffId: string;
let clientId: string;

class Rollback extends Error {}

/** Hält einen Kind-Insert offen, bis `probe` fertig ist, und rollt ihn dann zurück. */
async function whileChildInsertIsOpen<T>(probe: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let signalLocked!: () => void;
  const locked = new Promise<void>((resolve) => (signalLocked = resolve));
  const open = holder
    .$transaction(
      async (tx) => {
        await tx.clientResponsibility.create({
          data: { tenantId, clientId, staffId, role: 'FACHLICH' },
        });
        signalLocked();
        await released;
        throw new Rollback();
      },
      { timeout: 20_000 },
    )
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  await locked;
  try {
    return await probe();
  } finally {
    release();
    await open;
  }
}

beforeAll(async () => {
  if (!hasDatabase) return;
  const seed = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  tenantId = (
    await holder.tenant.create({ data: { name: 'Paar-Guard-Sperre', slug: `pair-lock-${seed}` } })
  ).id;
  staffId = (
    await holder.staffUser.create({
      data: {
        tenantId,
        email: `pair-lock-${seed}@example.test`,
        fullName: 'Paar-Guard',
        passwordHash: 'synthetic',
      },
    })
  ).id;
  clientId = (
    await holder.client.create({ data: { tenantId, kind: 'NATPERS', name: 'Sperr-Mandant' } })
  ).id;
});

afterAll(async () => {
  if (tenantId) await holder.tenant.delete({ where: { id: tenantId } });
  await Promise.all([holder.$disconnect(), other.$disconnect()]);
});

describeWithDatabase('Paar-Guard-Sperre gegen PostgreSQL', () => {
  it('lässt Stammdaten-Updates des Mandanten parallel zu einem Kind-Insert durch', async () => {
    const updated = await whileChildInsertIsOpen(() =>
      other.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
        return tx.$executeRaw`UPDATE client SET name = 'Umbenannt' WHERE id = ${clientId}::uuid`;
      }),
    );
    expect(updated).toBe(1);
  });

  it('serialisiert explizites FOR UPDATE weiterhin mit dem offenen Kind-Insert', async () => {
    await expect(
      whileChildInsertIsOpen(() =>
        other.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
          return tx.$queryRaw`SELECT id FROM client WHERE id = ${clientId}::uuid FOR UPDATE`;
        }),
      ),
    ).rejects.toThrow(/55P03|lock timeout/i);
  });

  it('weist ein Cross-Tenant-Paar unverändert ab', async () => {
    const foreignTenant = await holder.tenant.create({
      data: { name: 'Fremd', slug: `pair-lock-foreign-${Date.now()}` },
    });
    try {
      const error = await holder.clientResponsibility
        .create({ data: { tenantId: foreignTenant.id, clientId, staffId, role: 'FACHLICH' } })
        .then(
          () => null,
          (rejected: unknown) => rejected,
        );
      expect(error).toMatchObject({ code: 'P2003' });
      expect(JSON.stringify((error as { meta?: unknown }).meta)).toContain(
        'nicht zum selben Mandanten-Scope',
      );
    } finally {
      await holder.tenant.delete({ where: { id: foreignTenant.id } });
    }
  });
});
