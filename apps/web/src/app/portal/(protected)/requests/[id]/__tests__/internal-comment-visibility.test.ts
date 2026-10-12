// @vitest-environment jsdom
// Fachkatalog: REQ-INTERNAL-COMMENT-001
// Anforderungsdetail im Portal: interne Kanzlei-Kommentare werden weder
// geladen noch angezeigt (Render-Test statt Quelltextprüfung, B-08, Welle 15).
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  queryRaw: vi.fn(async () => [{ managed: false }]),
  internalCommentAccess: vi.fn(),
}));

vi.mock('@/server/auth/portal', () => ({
  portalAuth: vi.fn(async () => ({
    user: {
      tenantId: 'tenant-1',
      contactId: 'contact-1',
      clientId: 'client-1',
      email: 'max@mandant.example',
    },
  })),
}));
vi.mock('@/server/auth/portal-profiles', () => ({ findPortalProfilesForContact: vi.fn() }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      request: { findFirst: h.findFirst },
      $queryRaw: h.queryRaw,
      // Jeder Zugriff auf das Kommentarmodell aus der Portalseite fällt auf.
      get requestInternalComment() {
        h.internalCommentAccess();
        return { findMany: vi.fn(async () => []) };
      },
    }),
  ),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('../auto-profile-switch', () => ({ AutoProfileSwitch: () => null }));
vi.mock('../response-form', () => ({ PortalResponseForm: () => null }));

import PortalRequestDetailPage from '../page';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  // Selbst wenn eine Abfrage interne Kommentare lieferte, darf die Seite sie
  // nicht darstellen.
  h.findFirst.mockResolvedValue({
    id: REQUEST_ID,
    clientId: 'client-1',
    title: 'Belege Q3',
    description: 'Bitte Belege hochladen.',
    status: 'OPEN',
    dueAt: null,
    createdAt: new Date('2026-10-06T08:00:00.000Z'),
    responses: [],
    formSubmission: null,
    internalComments: [
      { id: 'comment-1', authorName: 'Erika Muster', body: 'Nur intern', createdAt: new Date() },
    ],
  });
});

describe('Anforderungsdetail (Portal)', () => {
  it('lädt und zeigt keine internen Kanzlei-Kommentare', async () => {
    await renderServer(PortalRequestDetailPage({ params: Promise.resolve({ id: REQUEST_ID }) }));
    expect(screen.getByRole('heading', { level: 1, name: 'Belege Q3' })).toBeTruthy();
    const [args] = h.findFirst.mock.calls[0]!;
    expect(Object.keys(args.include)).not.toContain('internalComments');
    expect(args.where).toEqual({ id: REQUEST_ID, clientId: 'client-1' });
    expect(document.body.textContent).not.toMatch(/Kanzlei-intern|Nur intern|Erika Muster/);
    expect(screen.queryByRole('form', { name: 'Interner Kommentar' })).toBeNull();
    expect(h.internalCommentAccess).not.toHaveBeenCalled();
  });
});
