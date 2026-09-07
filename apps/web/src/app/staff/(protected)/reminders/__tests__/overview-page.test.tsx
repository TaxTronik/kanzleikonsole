import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const m = vi.hoisted(() => ({
  overview: vi.fn(),
  detail: vi.fn(),
  rows: vi.fn(),
  withTenant: vi.fn(),
  session: { user: { tenantId: 'tenant-a', staffId: 'staff-a' } },
}));
vi.mock('@/server/auth/staff-page', () => ({ requireStaffPage: async () => m.session }));
vi.mock('@/server/auth/rbac', () => ({
  isStaffAdmin: () => false,
  accessibleClientsWhereFor: async () => ({}),
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenant }));
vi.mock('@/server/reminders/queries', () => ({ loadReminderOverview: m.overview }));
vi.mock('@/server/reminders/detail', () => ({ loadReminderDetail: m.detail }));
vi.mock('../[id]/reminder-detail-view', () => ({ ReminderDetailView: () => null }));
vi.mock('../reminders-overview', () => ({
  RemindersOverview: (props: unknown) => {
    m.rows(props);
    return null;
  },
}));
vi.mock('../new-reminder-form', () => ({ NewReminderForm: () => null }));
vi.mock('../notify-mode-toggle', () => ({ NotifyModeToggle: () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.ComponentProps<'a'>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import RemindersPage from '../page';
import ReminderDetailPage from '../[id]/page';

beforeEach(() => {
  vi.clearAllMocks();
  m.overview.mockResolvedValue({ rows: [{ id: 'row-a' }], total: 61, page: 2, pageSize: 25 });
  m.withTenant.mockResolvedValue({ clients: [], staffOptions: [], notifyMode: 'ALL' });
});

describe('REMINDER-TICKET-001 – Übersicht mit serverseitigen Filtern', () => {
  it.each(['123', '11111111-1111-4111-8111-111111111111'])(
    'übergibt Direktlink %s und beide unabhängigen Historyseiten an denselben Detailresolver',
    async (id) => {
      m.withTenant.mockResolvedValue([]);
      m.detail.mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        ticketNumber: 123,
        subject: 'Ein Ticket',
        createdByStaff: 'staff-a',
        clientId: null,
      });
      const html = renderToStaticMarkup(
        await ReminderDetailPage({
          params: Promise.resolve({ id }),
          searchParams: Promise.resolve({ commentsPage: '3', attachmentsPage: '2' }),
        }),
      );
      expect(m.detail).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', actorId: 'staff-a', actorType: 'STAFF' },
        m.session,
        id,
        { commentsPage: 3, attachmentsPage: 2 },
      );
      expect(html).toContain('#123</span> Ein Ticket');
    },
  );
  it('transportiert Zustand, Zuständigkeit, Suche und Seite gemeinsam und bewahrt sie in Navigation', async () => {
    const html = renderToStaticMarkup(
      await RemindersPage({
        searchParams: Promise.resolve({
          scope: 'alle',
          status: 'archived',
          q: ' #123 ',
          page: '2',
        }),
      }),
    );
    expect(m.overview).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', actorId: 'staff-a', actorType: 'STAFF' },
      m.session,
      { scope: 'alle', status: 'archived', q: '#123', page: 2, pageSize: 25 },
    );
    expect(m.rows).toHaveBeenCalledWith(
      expect.objectContaining({ rows: [{ id: 'row-a' }], status: 'archived', scope: 'alle' }),
    );
    const links = [...html.matchAll(/href="([^"]+)"/g)].map(
      (match) => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://fixture.test'),
    );
    expect(
      links.some(
        (url) =>
          url.searchParams.get('page') === '3' &&
          url.searchParams.get('scope') === 'alle' &&
          url.searchParams.get('status') === 'archived' &&
          url.searchParams.get('q') === '#123',
      ),
    ).toBe(true);
    expect(
      links.some(
        (url) =>
          url.searchParams.get('scope') === 'vonmir' &&
          url.searchParams.get('status') === 'archived' &&
          url.searchParams.get('q') === '#123' &&
          !url.searchParams.has('page'),
      ),
    ).toBe(true);
    expect(
      links.some(
        (url) =>
          url.searchParams.get('status') === 'done' &&
          url.searchParams.get('q') === '#123' &&
          !url.searchParams.has('page'),
      ),
    ).toBe(true);
  });

  it('setzt ungültige Zustände und Seiten auf den definierten Anfang zurück', async () => {
    await RemindersPage({
      searchParams: Promise.resolve({
        scope: 'fremd',
        status: 'deleted',
        q: 'x'.repeat(201),
        page: 'Infinity',
      }),
    });
    expect(m.overview).toHaveBeenCalledWith(expect.anything(), m.session, {
      scope: 'mir',
      status: 'open',
      q: 'x'.repeat(200),
      page: 1,
      pageSize: 25,
    });
  });
});
