// Fachkatalog: ACCESS-NOTIFICATION-RECIPIENT-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): tax-news-fetch über die App-Rolle.
//
// Abonnenten, vorhandene und neue Hinweise sowie der Lauf-Marker laufen je
// Tenant im SYSTEM-Kontext über taxtronik_app (RLS). Beim Owner-Client bleiben
// die mandantenübergreifende Feed-Liste (hier auf die Fixture-Tenants
// begrenzt) und der globale Nachrichten-Cache tax_news_item. Der RSS-Abruf ist
// eine Attrappe. Belegt: dieselben Hinweise wie bisher (je Tenant nur an die
// eigenen Abonnenten), kein Duplikat beim zweiten Lauf, der Lauf-Marker je
// Tenant, kein weiterer Owner-Zugriff, und Feeds und Hinweise des anderen
// Tenants bleiben im Kontext von Tenant A unsichtbar.
//
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1).
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertAppRoleConnection,
  assertLoopbackDatabases,
  createStaffFixture,
  createTenantFixture,
  deleteTenantFixtures,
  ownerAccess,
  resetOwnerAccess,
  type Owner,
} from '../../__tests__/app-role-db';

// B-02: lokal per WORKER_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env['WORKER_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'WORKER_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) assertLoopbackDatabases('WORKER_DB_TEST');

// Eindeutige Feed-Daten je Lauf: tax_news_item ist ein globaler Cache.
const h = vi.hoisted(() => ({
  tenants: [] as string[],
  feed: `https://s01-tax-news.example.test/${globalThis.crypto.randomUUID()}/rss.xml`,
  guid: `s01-guid-${globalThis.crypto.randomUUID()}`,
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/rss', () => ({
  fetchRssFeed: async (url: string) =>
    url === h.feed
      ? [
          {
            source: h.feed,
            guid: h.guid,
            title: 'Synthetische Steuernachricht',
            summary: '',
            link: 'https://s01-tax-news.example.test/1',
            publishedAt: new Date(),
          },
        ]
      : [],
}));
vi.mock('@taxtronik/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/db')>();
  const { guardOwnerClient } = await import('../../__tests__/app-role-db');
  const real = actual.prismaOwner;
  return {
    ...actual,
    prismaOwner: guardOwnerClient(
      real,
      ['rssFeed.findMany', 'taxNewsItem.findMany', 'taxNewsItem.createMany'],
      {
        // Die Feed-Liste des Jobs, begrenzt auf die Tenants dieser Suite.
        'rssFeed.findMany': (async (args: { where: object }) =>
          real.rssFeed.findMany({
            ...(args as object),
            where: { AND: [args.where, { tenantId: { in: h.tenants } }] },
          } as Parameters<typeof real.rssFeed.findMany>[0])) as never,
      },
    ),
  };
});

import { prisma, withSystemContext } from '@taxtronik/db';
import { processors } from './mocks/bullmq';
import '../tax-news-fetch';

const describeDb = enabled ? describe : describe.skip;

describeDb('S-01 tax-news-fetch via the app role', () => {
  let owner: Owner;
  const a = { tenant: '', staff: '', feed: '' };
  const b = { tenant: '', staff: '', feed: '' };

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    for (const [fixture, label] of [
      [a, 'tax-news-a'],
      [b, 'tax-news-b'],
    ] as const) {
      fixture.tenant = await createTenantFixture(owner, label);
      fixture.staff = await createStaffFixture(owner, fixture.tenant, { name: label });
      await owner.staffUser.update({
        where: { id: fixture.staff },
        data: { taxNewsNotify: true },
      });
      fixture.feed = (
        await owner.rssFeed.create({
          data: {
            tenantId: fixture.tenant,
            staffId: fixture.staff,
            name: `Feed ${label}`,
            url: h.feed,
          },
          select: { id: true },
        })
      ).id;
    }
    h.tenants = [a.tenant, b.tenant];
  });

  afterAll(async () => {
    if (owner) {
      await deleteTenantFixtures(owner, [a.tenant, b.tenant]);
      await owner.taxNewsItem.deleteMany({ where: { source: h.feed } });
    }
  });

  it('benachrichtigt je Tenant nur die eigenen Abonnenten, ohne Owner-Zugriff auf Mandantendaten', async () => {
    resetOwnerAccess();
    await expect(processors.get('tax-news-fetch')!({ data: {} })).resolves.toEqual({
      feeds: 1,
      fetched: 1,
      inserted: 1,
      notifications: 2,
    });

    const item = await owner.taxNewsItem.findUniqueOrThrow({
      where: { source_guid: { source: h.feed, guid: h.guid } },
      select: { id: true },
    });
    for (const fixture of [a, b]) {
      expect(
        await owner.notification.findMany({
          where: { tenantId: fixture.tenant },
          select: { staffId: true, kind: true, resourceType: true, resourceId: true, title: true },
        }),
      ).toEqual([
        {
          staffId: fixture.staff,
          kind: 'TAX_NEWS_NEW',
          resourceType: 'tax_news_item',
          resourceId: item.id,
          title: `Feed ${fixture === a ? 'tax-news-a' : 'tax-news-b'}: Synthetische Steuernachricht`,
        },
      ]);
      expect(
        await owner.tenantSetting.count({
          where: { tenantId: fixture.tenant, key: 'tax-news.last-fetch-at' },
        }),
      ).toBe(1);
    }

    // Zweiter Lauf: keine doppelten Hinweise.
    await expect(processors.get('tax-news-fetch')!({ data: {} })).resolves.toMatchObject({
      inserted: 0,
      notifications: 0,
    });
    expect(
      await owner.notification.count({ where: { tenantId: { in: [a.tenant, b.tenant] } } }),
    ).toBe(2);
    expect(ownerAccess.denied).toEqual([]);
    expect([...new Set(ownerAccess.allowed)].sort()).toEqual([
      'rssFeed.findMany',
      'taxNewsItem.createMany',
      'taxNewsItem.findMany',
    ]);
  });

  it('zeigt im SYSTEM-Kontext von Tenant A keine Feeds und Hinweise von Tenant B', async () => {
    expect(
      await withSystemContext(a.tenant, async (tx) => ({
        feeds: await tx.rssFeed.findMany({ where: { id: b.feed } }),
        notifications: await tx.notification.findMany({ where: { tenantId: b.tenant } }),
      })),
    ).toEqual({ feeds: [], notifications: [] });
  });
});
