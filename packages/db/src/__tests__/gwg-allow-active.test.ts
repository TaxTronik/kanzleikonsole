// =============================================================================
// GwG-Schranke (DB-Invariante) — Pflicht in CI
//
// Kern-Compliance-Invariante (§ 8 GwG): Ein Mandant darf NUR aktiv geschaltet
// werden (client.allow_active = TRUE), wenn ein VERIFIED und nicht-abgelaufener
// gwg_check existiert. Durchgesetzt vom DB-Trigger
// `client_allow_active_requires_gwg` (BEFORE UPDATE OF allow_active, iter4_gwg)
// — unabhängig vom App-Guard, fail-closed auch bei Migrations-Drift oder
// versehentlichem Owner-Zugriff.
//
// Der Trigger ist KEIN RLS-Mechanismus und greift für jede Rolle (auch den
// BYPASSRLS-Owner). Daher reicht der Owner-Client fürs Setup + die Assertions.
//
// Voraussetzung: Postgres läuft, DATABASE_URL gesetzt (Owner-URL).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const hasDatabase = Boolean(process.env['DATABASE_URL']);

if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('GwG-Schranken-Test braucht DATABASE_URL in CI (Owner-URL fürs Setup).');
}

const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId: string;

const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  const tenant = await owner.tenant.create({
    data: { slug: `test-gwg-${Date.now()}`, name: 'GwG-Schranke Test' },
  });
  tenantId = tenant.id;
});

afterAll(async () => {
  await owner.tenant.deleteMany({ where: { id: tenantId } });
  await owner.$disconnect();
});

/** Frischer Mandant, allow_active=false (Default). */
async function makeClient(name: string): Promise<string> {
  const c = await owner.client.create({
    data: { tenantId, kind: 'JURPERS', name, allowActive: false },
  });
  return c.id;
}

async function makeGwgCheck(
  clientId: string,
  status: 'DRAFT' | 'IN_REVIEW' | 'VERIFIED' | 'REJECTED' | 'EXPIRED',
  validUntil: Date | null,
): Promise<void> {
  await owner.gwgCheck.create({
    data: { tenantId, clientId, status, validUntil },
  });
}

function activate(clientId: string): Promise<unknown> {
  return owner.client.update({ where: { id: clientId }, data: { allowActive: true } });
}

describeWithDatabase('GwG-Schranke: allow_active erfordert verifizierten gwg_check', () => {
  it('ohne gwg_check: Aktivierung wird vom Trigger blockiert', async () => {
    const id = await makeClient('Ohne Check');
    await expect(activate(id)).rejects.toThrow();
  });

  it('mit DRAFT-Check: Aktivierung blockiert (nicht VERIFIED)', async () => {
    const id = await makeClient('Draft Check');
    await makeGwgCheck(id, 'DRAFT', null);
    await expect(activate(id)).rejects.toThrow();
  });

  it('mit IN_REVIEW-Check: Aktivierung blockiert', async () => {
    const id = await makeClient('In Review');
    await makeGwgCheck(id, 'IN_REVIEW', null);
    await expect(activate(id)).rejects.toThrow();
  });

  it('mit REJECTED-Check: Aktivierung blockiert', async () => {
    const id = await makeClient('Rejected');
    await makeGwgCheck(id, 'REJECTED', null);
    await expect(activate(id)).rejects.toThrow();
  });

  it('mit VERIFIED, aber abgelaufenem Check: Aktivierung blockiert', async () => {
    const id = await makeClient('Verified Expired');
    await makeGwgCheck(id, 'VERIFIED', new Date(Date.now() - HOUR));
    await expect(activate(id)).rejects.toThrow();
  });

  it('mit VERIFIED + Gültigkeit in der Zukunft: Aktivierung erlaubt', async () => {
    const id = await makeClient('Verified Valid');
    await makeGwgCheck(id, 'VERIFIED', new Date(Date.now() + 365 * 24 * HOUR));
    await expect(activate(id)).resolves.toBeTruthy();
    const c = await owner.client.findUnique({ where: { id }, select: { allowActive: true } });
    expect(c?.allowActive).toBe(true);
  });

  it('mit VERIFIED + unbefristet (valid_until NULL): Aktivierung erlaubt', async () => {
    const id = await makeClient('Verified Unbefristet');
    await makeGwgCheck(id, 'VERIFIED', null);
    await expect(activate(id)).resolves.toBeTruthy();
  });

  it('Deaktivierung (allow_active=false) ist immer erlaubt — Trigger feuert nur auf TRUE', async () => {
    const id = await makeClient('Deaktivieren');
    await makeGwgCheck(id, 'VERIFIED', null);
    await activate(id);
    await expect(
      owner.client.update({ where: { id }, data: { allowActive: false } }),
    ).resolves.toBeTruthy();
  });
});
