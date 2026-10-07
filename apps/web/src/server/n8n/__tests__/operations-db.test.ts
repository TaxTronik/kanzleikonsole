// Fachkatalog: ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): n8n-Callback-Lesepfade über die App-Rolle.
//
// Überfällige Anforderungen, Anforderungsdetails, ablaufende GwG-Prüfungen und
// die Crash-Recovery der Callback-Receipts laufen mit dem authentifizierten
// Tenant im SYSTEM-Kontext über taxtronik_app (RLS). Der Owner-Client der
// Operationen ist hier vollständig gesperrt. Belegt gegen PostgreSQL: dieselben
// Zeilen wie bisher für Tenant A, und Anforderungen, GwG-Prüfungen und Receipts
// von Tenant B bleiben für Tenant A unsichtbar, auch bei bekannter ID.
//
// Wie CI: DATABASE_URL ist die Owner-Rolle (nur Fixtures), DATABASE_APP_URL
// die App-Rolle. Nur mit ausdrücklichem Opt-in (N8N_OPERATIONS_DB_TEST=1); die
// Tenants behalten ihre aufbewahrungspflichtigen GwG-Prüfungen in der
// Wegwerf-Datenbank.
// =============================================================================

import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

const enabled = process.env['N8N_OPERATIONS_DB_TEST'] === '1';
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`N8N_OPERATIONS_DB_TEST requires a valid ${name}.`);
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname.length < 2 ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      throw new Error(`N8N_OPERATIONS_DB_TEST requires a loopback PostgreSQL ${name}.`);
    }
  }
}

const owner = vi.hoisted(() => ({ calls: [] as string[] }));

// Jeder Zugriff der Operationen auf den Owner-Client wird protokolliert und wirft.
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: new Proxy(
    {},
    {
      get(_target, model) {
        if (typeof model !== 'string' || model === 'then') return undefined;
        return new Proxy(
          {},
          {
            get(_delegate, method) {
              if (typeof method !== 'string' || method === 'then') return undefined;
              return () => {
                owner.calls.push(`${model}.${method}`);
                throw new Error(`S-01: Owner-Client für ${model}.${method} benutzt`);
              };
            },
          },
        );
      },
    },
  ),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
vi.mock('@/server/notifications/service', () => ({ notify: vi.fn() }));
vi.mock('@/server/risk', () => ({ receiveResearchResult: vi.fn() }));
vi.mock('@/server/settings/modules', () => ({ readModules: vi.fn() }));

import * as db from '@taxtronik/db';
import {
  getCompletedN8nCallbackReceipt,
  N8N_CALLBACK_OPERATIONS,
} from '@/server/n8n/callback-receipts';
import {
  getExpiringGwgChecks,
  getOverdueRequestsForTenant,
  getRequestDetailForTenant,
} from '../operations';

const { withSystemContext } = db;
// Fixtures legt die echte Owner-Verbindung an (nicht der gesperrte Client der Operationen).
const fixtures = db.prismaOwner;
const DAY_MS = 24 * 60 * 60 * 1000;

const describeDb = enabled ? describe : describe.skip;

describeDb('S-01 n8n callback reads via the app role', () => {
  type Fixture = {
    tenant: string;
    client: string;
    contact: string;
    request: string;
    check: string;
    connection: string;
  };
  const a = {} as Fixture;
  const b = {} as Fixture;
  const now = new Date();
  const receiptId = `s01-delivery-${randomUUID()}`;

  async function seed(fixture: Fixture, label: string) {
    const suffix = randomUUID();
    fixture.tenant = (
      await fixtures.tenant.create({
        data: { slug: `s01-n8n-${label}-${suffix}`, name: `S-01 n8n ${label}` },
      })
    ).id;
    const staff = (
      await fixtures.staffUser.create({
        data: {
          tenantId: fixture.tenant,
          email: `s01-n8n-${label}-${suffix}@example.test`,
          fullName: `Synthetic ${label}`,
          passwordHash: 'x',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    fixture.client = (
      await fixtures.client.create({
        data: { tenantId: fixture.tenant, kind: 'JURPERS', name: `Mandant ${label}` },
      })
    ).id;
    const gwg = await createVerifiedLegalEntityGwgFixture(fixtures, {
      tenantId: fixture.tenant,
      clientId: fixture.client,
      verifiedBy: staff,
      registerNumber: `HRB-N8N-${suffix}`,
      validUntil: new Date(now.getTime() + 10 * DAY_MS),
    });
    fixture.check = gwg.id;
    await fixtures.client.update({ where: { id: fixture.client }, data: { allowActive: true } });
    fixture.contact = (
      await fixtures.clientContact.create({
        data: {
          tenantId: fixture.tenant,
          clientId: fixture.client,
          email: `s01-n8n-contact-${label}-${suffix}@example.test`,
          fullName: `Kontakt ${label}`,
        },
      })
    ).id;
    fixture.request = (
      await fixtures.request.create({
        data: {
          tenantId: fixture.tenant,
          clientId: fixture.client,
          title: `Unterlagen ${label}`,
          description: 'Synthetische Anforderung',
          dueAt: new Date(now.getTime() - 3 * DAY_MS),
          createdByStaff: staff,
        },
      })
    ).id;
    fixture.connection = (
      await fixtures.n8nConnection.create({
        data: { tenantId: fixture.tenant, name: `n8n ${label}` },
      })
    ).id;
  }

  beforeAll(async () => {
    await seed(a, 'a');
    await seed(b, 'b');
    const [role] = await withSystemContext(
      a.tenant,
      (tx) =>
        tx.$queryRaw<Array<{ role: string; bypass: boolean; superuser: boolean }>>`
          SELECT current_user::text AS role, rolbypassrls AS bypass, rolsuper AS superuser
            FROM pg_roles WHERE rolname = current_user`,
    );
    expect(role).toEqual({ role: 'taxtronik_app', bypass: false, superuser: false });
    // Ein abgeschlossener Research-Callback je Tenant unter derselben Request-ID.
    for (const fixture of [a, b]) {
      await fixtures.n8nCallbackReceipt.create({
        data: {
          tenantId: fixture.tenant,
          connectionId: fixture.connection,
          requestIdHash: createHash('sha256').update(receiptId, 'utf8').digest('hex'),
          operation: N8N_CALLBACK_OPERATIONS.researchResult,
          resultId: fixture.request,
        },
      });
    }
  });

  it('liefert überfällige Anforderungen und Details nur des authentifizierten Tenants', async () => {
    owner.calls.length = 0;
    const overdue = await getOverdueRequestsForTenant(a.tenant, now);
    expect(overdue).toEqual({
      count: 1,
      requests: [
        expect.objectContaining({
          id: a.request,
          tenantId: a.tenant,
          clientName: 'Mandant a',
          contactName: 'Kontakt a',
          daysOverdue: 3,
        }),
      ],
    });

    expect(await getRequestDetailForTenant(a.tenant, a.request)).toMatchObject({
      id: a.request,
      tenantId: a.tenant,
      clientName: 'Mandant a',
      notifiableContacts: [{ id: a.contact, fullName: 'Kontakt a' }],
    });
    // Bekannte fremde ID: im Kontext von Tenant A unsichtbar.
    expect(await getRequestDetailForTenant(a.tenant, b.request)).toBeNull();
    expect(owner.calls).toEqual([]);
  });

  it('liefert ablaufende GwG-Prüfungen nur des authentifizierten Tenants', async () => {
    owner.calls.length = 0;
    const result = await getExpiringGwgChecks(a.tenant, 30, now);
    expect(result.checks.map((check) => check.id)).toEqual([a.check]);
    expect(result.checks[0]).toMatchObject({ clientId: a.client, clientName: 'Mandant a' });
    expect(owner.calls).toEqual([]);
  });

  it('findet abgeschlossene Receipts nur im eigenen Tenant', async () => {
    owner.calls.length = 0;
    const receipt = (tenantId: string, connectionId: string) => ({
      tenantId,
      connectionId,
      requestId: receiptId,
      operation: N8N_CALLBACK_OPERATIONS.researchResult,
    });
    expect(await getCompletedN8nCallbackReceipt(receipt(a.tenant, a.connection))).toEqual({
      resultId: a.request,
    });
    // Receipt von Tenant B: mit Tenant A als authentifiziertem Tenant unsichtbar.
    expect(await getCompletedN8nCallbackReceipt(receipt(a.tenant, b.connection))).toBeNull();
    expect(owner.calls).toEqual([]);
  });

  it('zeigt im SYSTEM-Kontext von Tenant A keine Zeilen von Tenant B', async () => {
    const foreign = await withSystemContext(a.tenant, async (tx) => ({
      requests: await tx.request.findMany({ where: { id: b.request } }),
      contacts: await tx.clientContact.findMany({ where: { id: b.contact } }),
      checks: await tx.gwgCheck.findMany({ where: { id: b.check } }),
      receipts: await tx.n8nCallbackReceipt.findMany({ where: { connectionId: b.connection } }),
    }));
    expect(foreign).toEqual({ requests: [], contacts: [], checks: [], receipts: [] });
  });
});
