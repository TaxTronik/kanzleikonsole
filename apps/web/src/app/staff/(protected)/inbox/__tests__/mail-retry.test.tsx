// Fachkatalog: PORTAL-INBOX-SUBMISSION-001 (Entwurf).
// Review-Entscheidung C1: „Erneut senden" für den neutralen E-Mail-Hinweis einer
// Kanzleiantwort erscheint nur, solange der letzte Versuch sicher wiederholbar
// ist (`safeToRetry`), und ruft die bestehende Retry-Action auf.
//
// Kein DOM in der Testumgebung: serverseitig rendern, Props der <button>
// abfangen und den Klick direkt auslösen.

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  buttons: [] as Array<Record<string, unknown>>,
  transitions: [] as Array<Promise<unknown>>,
  retry: vi.fn(),
  retryable: vi.fn(),
  thread: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useTransition: () =>
      [
        false,
        (callback: () => unknown) => {
          probe.transitions.push(Promise.resolve(callback()));
        },
      ] as const,
  };
});

for (const runtime of ['react/jsx-runtime', 'react/jsx-dev-runtime']) {
  vi.doMock(runtime, async () => {
    const original =
      await vi.importActual<Record<string, (...args: unknown[]) => unknown>>(runtime);
    const capture =
      (factory: (...args: unknown[]) => unknown) =>
      (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
        if (type === 'button') probe.buttons.push(props);
        return factory(type, props, ...rest);
      };
    return {
      ...original,
      ...(original.jsx ? { jsx: capture(original.jsx), jsxs: capture(original.jsxs!) } : {}),
      ...(original.jsxDEV ? { jsxDEV: capture(original.jsxDEV) } : {}),
    };
  });
}

vi.mock('next/navigation', () => ({ notFound: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('../actions', () => ({ retryInboxClientNotificationAction: probe.retry }));
vi.mock('../controls', () => ({ InboxStaffControls: (): ReactNode => null }));
vi.mock('../attachment-review', () => ({ InboxAttachmentReview: (): ReactNode => null }));
vi.mock('@/server/auth/staff-page', () => ({ requireStaffPage: vi.fn() }));
vi.mock('@/server/actions/staff-action', () => ({
  staffActionGuard: async () => ({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    session: { user: { tenantId: 'tenant-1', staffId: 'staff-1' } },
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  }),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => unknown) => run(tx),
}));
vi.mock('@/server/inbox/queries', () => ({ getStaffInboxThreadTx: probe.thread }));
vi.mock('@/server/inbox/access', () => ({ eligibleInboxStaffIdsTx: async () => new Set() }));
vi.mock('@/server/inbox/client-notification', () => ({
  retryableInboxClientMailsTx: probe.retryable,
}));

const tx = {
  staffUser: { findMany: vi.fn().mockResolvedValue([]) },
  documentType: { findMany: vi.fn().mockResolvedValue([]) },
};

const { InboxMailRetry, INBOX_MAIL_NOT_DELIVERED } = await import('../mail-retry');
const { default: StaffInboxThreadPage } = await import('../[id]/page');

function message(id: string, authorType: 'STAFF' | 'CLIENT_CONTACT') {
  return {
    id,
    authorType,
    authorName: authorType === 'STAFF' ? 'Kanzlei' : 'Mandant',
    body: `Text ${id}`,
    createdAt: new Date('2026-10-06T08:00:00.000Z'),
    attachments: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  probe.buttons = [];
  probe.transitions = [];
});

describe('„Erneut senden" am E-Mail-Hinweis', () => {
  it('erscheint im Verlauf nur an Kanzleiantworten mit sicher wiederholbarem Hinweis', async () => {
    probe.thread.mockResolvedValue({
      id: 'thread-1',
      clientId: 'client-1',
      clientName: 'Müller GmbH',
      subject: 'Belege',
      topic: 'GENERAL',
      status: 'OPEN',
      attention: 'CLIENT',
      assignedStaffId: null,
      lastMessageAt: new Date('2026-10-06T08:00:00.000Z'),
      createdByContactName: 'Max Muster',
      resolvedAt: null,
      messages: [
        message('client-message', 'CLIENT_CONTACT'),
        message('staff-retryable', 'STAFF'),
        message('staff-delivered', 'STAFF'),
      ],
    });
    probe.retryable.mockResolvedValue(new Set(['staff-retryable']));

    const html = renderToStaticMarkup(
      await StaffInboxThreadPage({ params: Promise.resolve({ id: 'thread-1' }) }),
    );

    expect(probe.retryable).toHaveBeenCalledWith(tx, 'tenant-1', [
      'staff-retryable',
      'staff-delivered',
    ]);
    expect(html.match(/data-inbox-mail-retry=/g)).toHaveLength(1);
    expect(html).toContain('data-inbox-mail-retry="staff-retryable"');
    expect(html).toContain(INBOX_MAIL_NOT_DELIVERED);
    expect(html).toContain('Erneut senden');
  });

  it('ruft die bestehende Retry-Action mit der Nachricht auf', async () => {
    renderToStaticMarkup(<InboxMailRetry messageId="staff-retryable" />);
    const button = probe.buttons.find((props) => props['type'] === 'button');
    probe.retry.mockResolvedValueOnce({ ok: true, messageId: 'staff-retryable' });

    (button!['onClick'] as () => void)();
    await Promise.all(probe.transitions);

    expect(probe.retry).toHaveBeenCalledTimes(1);
    const form = probe.retry.mock.calls[0]![0] as FormData;
    expect([...form.entries()]).toEqual([['messageId', 'staff-retryable']]);
  });

  it('fängt einen unbestätigten Ausgang ab, statt den Fehler durchzureichen', async () => {
    renderToStaticMarkup(<InboxMailRetry messageId="staff-retryable" />);
    const button = probe.buttons.find((props) => props['type'] === 'button');
    probe.retry.mockRejectedValueOnce(new Error('network'));

    (button!['onClick'] as () => void)();

    await expect(Promise.all(probe.transitions)).resolves.toBeDefined();
    expect(probe.retry).toHaveBeenCalledTimes(1);
  });
});
