// @vitest-environment jsdom
// Fachkatalog: REQ-INTERNAL-COMMENT-001 (Kanaltrennung: interne Kommentare nur
// auf der Staff-Seite; Darstellung mit semantischen Flächen in hell und dunkel)
// Anforderungsdetail der Kanzlei als Render-Test gegen eine nachgebildete
// Tenant-Tx (B-08, Welle 15) statt Quelltextprüfung; deckt auch den früheren
// created-at-Test ab. Der Dateiname bleibt, weil die Regel ihn als test_ref
// führt. Die Portalseite prüft
// portal/(protected)/requests/[id]/__tests__/internal-comment-visibility.test.ts.
import { screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  canAccess: vi.fn(async () => true),
  loadMail: vi.fn(async () => new Map()),
  commentForms: [] as string[],
}));

vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['STAFF'] },
  })),
}));
vi.mock('@/server/auth/rbac', () => ({ canAccessClientTx: h.canAccess }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ request: { findUnique: h.findUnique } }),
  ),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('@/server/mail/delivery-status', () => ({ loadMailDeliveryTx: h.loadMail }));
vi.mock('@/server/mail/resend-actions', () => ({ resendMailOutboxAction: vi.fn() }));
vi.mock('../../../clients/[id]/requests/actions', () => ({
  closeRequestAction: vi.fn(),
  reopenRequestAction: vi.fn(),
}));
vi.mock('../../../knowledge/context/actions', () => ({ loadKnowledgeContextAction: vi.fn() }));
vi.mock('../staff-response-form', () => ({ StaffResponseForm: () => null }));
vi.mock('../internal-comment-form', () => ({
  InternalCommentForm: ({ requestId }: { requestId: string }) => {
    h.commentForms.push(requestId);
    return createElement('form', { 'aria-label': 'Interner Kommentar' });
  },
}));

import RequestDetailPage from '../page';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    clientId: 'client-1',
    client: { id: 'client-1', name: 'Muster GmbH' },
    title: 'Belege Q3',
    description: 'Bitte Belege hochladen.',
    status: 'OPEN',
    dueAt: null,
    createdAt: new Date('2026-10-06T08:00:00.000Z'),
    wikiArticleIds: [],
    responses: [],
    internalComments: [
      {
        id: 'comment-1',
        authorName: 'Erika Muster',
        body: 'Nur intern: Mandant telefonisch erinnert.',
        createdAt: new Date('2026-10-07T09:30:00.000Z'),
      },
    ],
    ...overrides,
  };
}

async function render() {
  return renderServer(
    RequestDetailPage({
      params: Promise.resolve({ id: REQUEST_ID }),
      searchParams: Promise.resolve({}),
    }),
  );
}

function internalCard(): HTMLElement {
  return screen.getByRole('heading', { name: 'Kanzlei-intern (1)' }).closest('.card')!;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.commentForms.length = 0;
  h.findUnique.mockResolvedValue(requestRow());
});

describe('Anforderungsdetail (Staff)', () => {
  it('zeigt Erstellungsdatum und -uhrzeit vollständig im Kopf', async () => {
    await render();
    expect(screen.getByText('Erstellt am 06.10.26, 10:00')).toBeTruthy();
  });

  it('lädt interne Kanzlei-Kommentare und bietet das interne Kommentarformular an', async () => {
    await render();
    const [args] = h.findUnique.mock.calls[0]!;
    expect(args.include.internalComments).toEqual({ orderBy: { createdAt: 'asc' } });
    const card = internalCard();
    expect(within(card).getByText('Intern · Erika Muster')).toBeTruthy();
    expect(within(card).getByText('Nur intern: Mandant telefonisch erinnert.')).toBeTruthy();
    expect(h.commentForms).toEqual([REQUEST_ID]);
  });

  it('stellt interne Kommentare mit semantischen, kontrastreichen Flächen dar', async () => {
    await render();
    const card = internalCard();
    expect([...card.classList]).toEqual(
      expect.arrayContaining(['border-l-amber-500', 'bg-surface-raised']),
    );
    expect(card.className).not.toContain('bg-amber-50/30');
    const list = card.querySelector('.divide-y')!;
    expect([...list.classList]).toContain('divide-border-subtle');
    expect(within(card).getByText('07.10.26, 11:30').className).toBe('text-xs text-muted');
  });

  it('verhält sich bei gesperrtem Mandanten wie nicht vorhanden', async () => {
    h.canAccess.mockResolvedValueOnce(false);
    await expect(render()).rejects.toThrow('notFound');
  });
});
