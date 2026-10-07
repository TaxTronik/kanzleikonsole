// Fachkatalog: ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): manueller Steuernachrichten-Abruf über die App-Rolle.
//
// Modulschalter, eigene Feeds, den eigenen Marker und den globalen
// Nachrichten-Cache tax_news_item (ohne RLS, App-Rolle darf anlegen) liest und
// schreibt der Dashboard-Abruf im Kontext des angemeldeten Mitarbeiters über
// taxtronik_app; der Owner-Client ist hier vollständig gesperrt. Nur der
// RSS-Abruf ist eine Attrappe. Belegt gegen PostgreSQL: dieselben Feeds,
// derselbe Cache-Eintrag und derselbe Marker wie bisher, ein zweiter Lauf
// verwirft das Duplikat (P2002) ohne Fehler, und Feed und Marker eines fremden
// Tenants mit derselben URL bleiben unberührt und im Kontext von Tenant A
// unsichtbar.
//
// Wie CI: DATABASE_URL ist die Owner-Rolle (nur Fixtures), DATABASE_APP_URL
// die App-Rolle. Nur mit ausdrücklichem Opt-in (TAX_NEWS_FETCH_DB_TEST=1).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = process.env['TAX_NEWS_FETCH_DB_TEST'] === '1';
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`TAX_NEWS_FETCH_DB_TEST requires a valid ${name}.`);
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname.length < 2 ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      throw new Error(`TAX_NEWS_FETCH_DB_TEST requires a loopback PostgreSQL ${name}.`);
    }
  }
}

// Eindeutige Feed-Daten je Lauf: tax_news_item ist ein globaler Cache.
const h = vi.hoisted(() => ({
  feed: `https://s01-web-news.example.test/${globalThis.crypto.randomUUID()}/rss.xml`,
  guid: `s01-web-guid-${globalThis.crypto.randomUUID()}`,
  ownerCalls: [] as string[],
}));

vi.mock('@taxtronik/rss', () => ({
  fetchRssFeed: async (url: string) =>
    url === h.feed
      ? [
          {
            source: h.feed,
            guid: h.guid,
            title: 'Synthetische Steuernachricht',
            summary: null,
            link: 'https://s01-web-news.example.test/1',
            publishedAt: null,
          },
        ]
      : [],
}));
// Jeder Zugriff auf den Owner-Client wird protokolliert und wirft.
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: new Proxy(
    {},
    {
      get(_target, model) {
        if (typeof model !== 'string' || model === 'then') return undefined;
        h.ownerCalls.push(model);
        throw new Error(`S-01: Owner-Client für ${model} benutzt`);
      },
    },
  ),
}));

import * as db from '@taxtronik/db';
import { fetchAndPersistTaxNews } from '../fetcher';

const { withTenantContext } = db;
// Fixtures legt die echte Owner-Verbindung an (nicht der überwachte Client des Abrufs).
const fixtures = db.prismaOwner;

const describeDb = enabled ? describe : describe.skip;

describeDb('S-01 manual tax-news fetch via the app role', () => {
  const a = { tenant: '', staff: '' };
  const b = { tenant: '', staff: '', feed: '' };

  async function seed(fixture: { tenant: string; staff: string }, label: string) {
    const suffix = randomUUID();
    fixture.tenant = (
      await fixtures.tenant.create({
        data: { slug: `s01-web-news-${label}-${suffix}`, name: `S-01 News ${label}` },
      })
    ).id;
    fixture.staff = (
      await fixtures.staffUser.create({
        data: {
          tenantId: fixture.tenant,
          email: `s01-web-news-${label}-${suffix}@example.test`,
          fullName: `Synthetic ${label}`,
          passwordHash: 'x',
          roles: { create: { role: 'EMPLOYEE' } },
        },
      })
    ).id;
    return (
      await fixtures.rssFeed.create({
        data: { tenantId: fixture.tenant, staffId: fixture.staff, name: label, url: h.feed },
        select: { id: true },
      })
    ).id;
  }

  beforeAll(async () => {
    await seed(a, 'a');
    b.feed = await seed(b, 'b');

    const [role] = await withTenantContext(
      { tenantId: a.tenant, actorId: a.staff, actorType: 'STAFF' },
      (tx) =>
        tx.$queryRaw<Array<{ role: string; bypass: boolean; superuser: boolean }>>`
          SELECT current_user::text AS role, rolbypassrls AS bypass, rolsuper AS superuser
            FROM pg_roles WHERE rolname = current_user`,
    );
    expect(role).toEqual({ role: 'taxtronik_app', bypass: false, superuser: false });
  });

  afterAll(async () => {
    for (const tenantId of [a.tenant, b.tenant].filter(Boolean)) {
      await fixtures.tenant.delete({ where: { id: tenantId } });
    }
    await fixtures.taxNewsItem.deleteMany({ where: { source: h.feed } });
  });

  it('lädt die eigenen Feeds, füllt den Cache und setzt den eigenen Marker wie bisher, ohne Owner-Zugriff', async () => {
    h.ownerCalls.length = 0;
    await expect(
      fetchAndPersistTaxNews({ tenantId: a.tenant, staffId: a.staff }),
    ).resolves.toMatchObject({ feeds: 1, fetched: 1, inserted: 1, errors: [] });
    // Zweiter Lauf: der Cache-Eintrag existiert schon, das Duplikat wird verworfen.
    await expect(
      fetchAndPersistTaxNews({ tenantId: a.tenant, staffId: a.staff }),
    ).resolves.toMatchObject({ feeds: 1, fetched: 1, inserted: 0, errors: [] });

    expect(await fixtures.taxNewsItem.count({ where: { source: h.feed, guid: h.guid } })).toBe(1);
    expect(
      await fixtures.tenantSetting.findMany({
        where: { tenantId: { in: [a.tenant, b.tenant] }, key: { startsWith: 'tax-news.' } },
        select: { tenantId: true, key: true },
      }),
    ).toEqual([{ tenantId: a.tenant, key: `tax-news.last-fetch-at.${a.staff}` }]);
    expect(h.ownerCalls).toEqual([]);
  });

  it('zeigt im Kontext von Tenant A weder Feed noch Einstellungen von Tenant B', async () => {
    expect(
      await withTenantContext(
        { tenantId: a.tenant, actorId: a.staff, actorType: 'STAFF' },
        async (tx) => ({
          feeds: await tx.rssFeed.findMany({ where: { id: b.feed } }),
          settings: await tx.tenantSetting.findMany({ where: { tenantId: b.tenant } }),
        }),
      ),
    ).toEqual({ feeds: [], settings: [] });
    expect(await fixtures.rssFeed.count({ where: { id: b.feed, active: true } })).toBe(1);
  });
});
