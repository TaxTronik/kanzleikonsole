import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    title: string;
    kind: string;
    body: string | null;
    href: string | null;
    createdAt: Date;
    readAt: Date | null;
  }>,
  requireStaffPage: vi.fn(),
  withTenantContext: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
}));

vi.mock('@/server/auth/staff-page', () => ({ requireStaffPage: fixture.requireStaffPage }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: fixture.withTenantContext }));
vi.mock('../actions', () => ({
  markNotificationReadAction: vi.fn(),
  markAllNotificationsReadAction: vi.fn(),
  markNotificationReadByIdAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import NotificationsPage from '../page';

function item(index: number, unread = true) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    title: `${unread ? 'Offener' : 'Gelesener'} Hinweis ${index}`,
    kind: 'SYSTEM_AUDIT_OK',
    body: null,
    href: null,
    createdAt: new Date(Date.UTC(2026, 8, 7, 0, index)),
    readAt: unread ? null : new Date(Date.UTC(2026, 8, 7, 1, index)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.rows = [];
  fixture.requireStaffPage.mockResolvedValue({
    user: { tenantId: 'tenant-test', staffId: 'staff-test' },
  });
  fixture.withTenantContext.mockImplementation(async (_ctx, run) =>
    run({ notification: { findMany: fixture.findMany, count: fixture.count } }),
  );
  fixture.count.mockImplementation(
    async () => fixture.rows.filter((row) => row.readAt === null).length,
  );
  fixture.findMany.mockImplementation(async ({ orderBy, take }) => {
    // PostgreSQL ASC defaults to NULLS LAST. Apply the real ordering contract
    // before LIMIT so a broken query cannot pass with pre-sorted fake rows.
    const ordering = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...fixture.rows]
      .sort((a, b) => {
        for (const order of ordering) {
          const [field, raw] = Object.entries(order)[0]! as [
            keyof typeof a,
            string | { sort: string; nulls?: string },
          ];
          const direction = typeof raw === 'string' ? raw : raw.sort;
          const left = a[field],
            right = b[field];
          if (left === right) continue;
          if (left === null || right === null) {
            const nullsFirst =
              typeof raw === 'object' ? raw.nulls === 'first' : direction === 'desc';
            return (left === null ? -1 : 1) * (nullsFirst ? 1 : -1);
          }
          const difference = left! < right! ? -1 : left! > right! ? 1 : 0;
          if (difference) return direction === 'desc' ? -difference : difference;
        }
        return 0;
      })
      .slice(0, take);
  });
});

async function renderPage() {
  return renderToStaticMarkup(await NotificationsPage());
}

describe('Benachrichtigungsseite — ACCESS-NOTIFICATION-RECIPIENT-001', () => {
  it('verdrängt ungelesene Hinweise nicht durch mehr als 100 gelesene Einträge', async () => {
    fixture.rows = [...Array.from({ length: 110 }, (_, i) => item(i, false)), item(200), item(201)];
    const html = await renderPage();
    expect(html.includes('2 ungelesen'), 'Gesamtzähler muss zwei ungelesene Hinweise zeigen').toBe(
      true,
    );
    expect(html).toContain('Offener Hinweis 200');
    expect(html).toContain('Offener Hinweis 201');
    expect(html.indexOf('Offener Hinweis 201')).toBeLessThan(html.indexOf('Gelesener Hinweis'));
    expect(html).toContain('Alle als gelesen markieren');
    expect(html.match(/<li\b/g)).toHaveLength(100);
  });

  it('zählt alle eigenen ungelesenen Hinweise unabhängig vom 100er-Anzeigefenster', async () => {
    fixture.rows = Array.from({ length: 125 }, (_, i) => item(i));
    const html = await renderPage();
    expect(
      html.includes('125 ungelesen'),
      'Gesamtzähler darf nicht durch LIMIT 100 gekürzt werden',
    ).toBe(true);
    expect(html.match(/<li\b/g)).toHaveLength(100);
    expect(html).toContain('100 Einträge angezeigt');
    expect(html).toContain('Offener Hinweis 124');
    expect(html).not.toContain('Offener Hinweis 0<');
  });

  it('liest Liste und Gesamtzähler im selben aktuellen Empfänger-/Tenantkontext', async () => {
    await renderPage();
    expect(fixture.withTenantContext).toHaveBeenCalledOnce();
    expect(fixture.withTenantContext).toHaveBeenCalledWith(
      { tenantId: 'tenant-test', actorId: 'staff-test', actorType: 'STAFF' },
      expect.any(Function),
    );
    expect(fixture.count).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-test',
        OR: [{ staffId: 'staff-test' }, { staffId: null }],
        readAt: null,
      },
    });
    expect(fixture.findMany.mock.calls[0]![0].where).toEqual({
      tenantId: 'tenant-test',
      OR: [{ staffId: 'staff-test' }, { staffId: null }],
    });
  });

  it('zeigt bei identischen Zeitpunkten eine feste Reihenfolge', async () => {
    const rows = [item(1), item(2), item(3)].map((row) => ({
      ...row,
      createdAt: new Date('2026-09-07T10:00:00Z'),
    }));
    fixture.rows = rows;
    const first = await renderPage();
    fixture.rows = [...rows].reverse();
    const second = await renderPage();
    const titles = (html: string) => html.match(/Offener Hinweis \d/g);
    expect(titles(first)).toEqual(['Offener Hinweis 3', 'Offener Hinweis 2', 'Offener Hinweis 1']);
    expect(titles(second)).toEqual(titles(first));
  });

  it('zeigt bei tatsächlich vollständig gelesenen Daten keine offene Aktion', async () => {
    fixture.rows = [item(1, false)];
    const html = await renderPage();
    expect(html).toContain('Alles gelesen.');
    expect(html).not.toContain('Alle als gelesen markieren');
    expect(html).toContain('Gelesener Hinweis 1');
  });

  it('zeigt einen leeren Datenbestand verständlich an', async () => {
    const html = await renderPage();
    expect(html).toContain('Keine Benachrichtigungen.');
    expect(html).toContain('Alles gelesen.');
    expect(html).not.toContain('<li');
  });

  it('öffnet nach fehlgeschlagener Seitenberechtigung keine Datenbanktransaktion', async () => {
    fixture.requireStaffPage.mockRejectedValueOnce(new Error('LOGIN_REQUIRED'));
    await expect(renderPage()).rejects.toThrow('LOGIN_REQUIRED');
    expect(fixture.withTenantContext).not.toHaveBeenCalled();
  });
});
