// Fachkatalog: GWG-ACTIVATION-GATE-001
//
// Review-Befund F-03: Datenbankfehler werden über Prisma-Code und SQLSTATE
// eingeordnet, Trigger-Ablehnungen zusätzlich über den Migrationsmarker. Dieser
// Test belegt die Fehlerform gegen echte Postgres-Trigger und Constraints
// (Prisma 7 + @prisma/adapter-pg), statt sie nur nachzubauen.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { databaseErrorInfo, isUniqueViolation } from '../database-error';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Fehlerklassifikations-Test braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

let tenantId: string;
let tenantSlug: string;
let staffId: string;
let clientId: string;

async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('Erwarteter Datenbankfehler blieb aus.');
}

beforeAll(async () => {
  if (!hasDatabase) return;
  const seed = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  tenantSlug = `error-classification-${seed}`;
  tenantId = (await owner.tenant.create({ data: { name: 'Fehlerklassen', slug: tenantSlug } })).id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `error-classification-${seed}@example.test`,
        fullName: 'Fehlerklassen',
        passwordHash: 'synthetic',
        roles: { create: { role: 'ADMIN' } },
      },
    })
  ).id;
  // allow_active bleibt false: die GwG-Schranke weist Anforderungen ab.
  clientId = (
    await owner.client.create({ data: { tenantId, kind: 'NATPERS', name: 'Nicht aktiv' } })
  ).id;
});

afterAll(async () => {
  if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describeWithDatabase('Einordnung echter Datenbankfehler (F-03)', () => {
  it('erkennt die GwG-Schranke des Anforderungs-Triggers über SQLSTATE und Marker', async () => {
    const error = await rejection(
      app.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT
            set_config('app.current_tenant_id', ${tenantId}, true),
            set_config('app.current_actor_id', ${staffId}, true),
            set_config('app.current_actor_type', 'STAFF', true)
        `;
        return tx.request.create({
          data: {
            tenantId,
            clientId,
            title: 'Unterlagen',
            description: 'Bitte nachreichen.',
            createdByStaff: staffId,
          },
        });
      }),
    );

    expect(databaseErrorInfo(error)).toMatchObject({
      kind: 'GWG_CLIENT_INACTIVE',
      prismaCode: 'P2039',
      sqlState: '23514',
    });
  });

  it('ordnet Unique-Verletzungen aus Prisma-Query und Raw-SQL gleich ein', async () => {
    const viaModel = await rejection(
      owner.tenant.create({ data: { name: 'Doppelt', slug: tenantSlug } }),
    );
    const viaRaw = await rejection(
      owner.$executeRaw`INSERT INTO "tenant" ("id", "name", "slug", "updated_at")
                        VALUES (gen_random_uuid(), 'Doppelt', ${tenantSlug}, now())`,
    );

    expect(databaseErrorInfo(viaModel)).toMatchObject({
      kind: 'UNIQUE_VIOLATION',
      prismaCode: 'P2002',
      sqlState: '23505',
    });
    expect(databaseErrorInfo(viaRaw)).toMatchObject({
      kind: 'UNIQUE_VIOLATION',
      prismaCode: 'P2010',
      sqlState: '23505',
    });
    expect(isUniqueViolation(viaRaw)).toBe(true);
  });

  it('ordnet eine FK-Verletzung aus Raw-SQL über SQLSTATE 23503 ein', async () => {
    const error = await rejection(
      owner.$executeRaw`INSERT INTO "client" ("id", "tenant_id", "kind", "name", "updated_at")
                        VALUES (gen_random_uuid(), gen_random_uuid(), 'NATPERS', 'Ohne Tenant', now())`,
    );

    expect(databaseErrorInfo(error)).toMatchObject({
      kind: 'FOREIGN_KEY_VIOLATION',
      prismaCode: 'P2010',
      sqlState: '23503',
    });
  });

  it('lässt andere Datenbank- und Nicht-Prisma-Fehler unklassifiziert', async () => {
    const error = await rejection(owner.$executeRaw`SELECT 1 / 0`);

    expect(databaseErrorInfo(error)).toMatchObject({ kind: 'OTHER', sqlState: '22012' });
    expect(databaseErrorInfo(new Error('(GwG-Schranke)'))).toBeNull();
  });
});
