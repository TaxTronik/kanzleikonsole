// Fachkatalog: MAIL-INBOX-001, ACCESS-CLIENT-MODE-001
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DOC_ID = '99999999-9999-4999-8999-999999999999';
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const HIDDEN_ID = '22222222-2222-4222-8222-222222222222';

const m = vi.hoisted(() => ({
  contactFindMany: vi.fn(),
  clientFindMany: vi.fn(),
  access: { OR: [{ vertraulich: false }] },
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('@/server/auth/staff-page', () => ({ requireStaffPage: async () => ({}) }));
// Modul-Gate der Seite (requireModulePage) ist separat getestet; hier aktiv.
vi.mock('@/server/settings/module-page', () => ({ requireModulePage: vi.fn(async () => ({})) }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: vi.fn() }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/server/actions/staff-action', () => ({
  staffActionGuard: async () => ({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
    session: { user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['EMPLOYEE'] } },
  }),
}));
vi.mock('@/server/auth/rbac', () => ({
  accessibleClientsWhereFor: async () => m.access,
  isStaffAdmin: () => false,
}));
vi.mock('../actions', () => ({
  connectMicrosoft: vi.fn(),
  importAttachment: vi.fn(),
  saveMailbox: vi.fn(),
  setMailboxEnabled: vi.fn(),
}));
vi.mock('@/server/mailbox/document-types', () => ({
  loadMailboxDocumentTypesTx: async () => [{ id: 'type-1', name: 'Beleg' }],
}));

const attachment = (patch: Record<string, unknown>) => ({
  id: 'att-' + String(patch.part),
  messageId: 'msg-1',
  filename: 'beleg.pdf',
  mimeType: 'application/pdf',
  sha256: 'a'.repeat(64),
  sizeBytes: 100,
  storageKey: 'key',
  documentId: null,
  clientId: null,
  error: null,
  createdAt: new Date(),
  ...patch,
});

vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run({
      inboundMailbox: { findMany: async () => [] },
      inboundMessage: {
        findMany: async () => [
          {
            id: 'msg-1',
            subject: 'Belege',
            sender: 'Kunde <KUNDE@example.test>',
            recipients: 'kanzlei@example.test',
            bodyText: 'Anbei',
            status: 'CLEAN',
            mailbox: { name: 'Postfach' },
            attachments: [
              attachment({ part: 1, status: 'IMPORTED', documentId: DOC_ID, clientId: CLIENT_ID }),
              attachment({ part: 2, status: 'CLEAN', clientId: CLIENT_ID }),
              attachment({ part: 3, status: 'IMPORTING', clientId: HIDDEN_ID }),
            ],
          },
        ],
      },
      clientContact: { findMany: m.contactFindMany },
      client: { findMany: m.clientFindMany },
    }),
}));

import MailboxPage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  m.contactFindMany.mockResolvedValue([
    { email: 'kunde@example.test', client: { id: CLIENT_ID, name: 'Kunde GmbH' } },
  ]);
  // Sichtbar ist nur CLIENT_ID; HIDDEN_ID fehlt unter der Zugriffsregel.
  m.clientFindMany.mockResolvedValue([
    {
      id: CLIENT_ID,
      name: 'Kunde GmbH',
      datevNo: null,
      addisonNo: null,
      allowActive: true,
      mandateEndedAt: null,
    },
  ]);
});

async function render() {
  return renderToStaticMarkup(await MailboxPage({ searchParams: Promise.resolve({}) }));
}

describe('Interner Posteingang — Mandantenzuordnung', () => {
  it('verlinkt importierte Anhänge auf die echte Dokumentroute', async () => {
    const html = await render();
    expect(html).toContain(`href="/staff/documents/${DOC_ID}"`);
    expect(html).not.toContain(`/staff/clients/${CLIENT_ID}/documents`);
  });

  it('rendert je offenem Anhang eine Suche statt eines <select> mit allen Mandanten', async () => {
    const html = await render();
    expect(html).not.toMatch(/<select[^>]*name="clientId"/);
    expect(html.match(/role="combobox"/g)).toHaveLength(2);
    // Vorgemerkte, sichtbare Zuordnung bleibt vorausgewählt; eine nicht
    // sichtbare wird weder vorausgewählt noch benannt.
    expect(html).toContain(`name="clientId" value="${CLIENT_ID}"`);
    expect(html).toContain('name="clientId" value=""');
    expect(html).not.toContain(HIDDEN_ID);
    expect(m.clientFindMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        AND: [
          {
            AND: [
              { tenantId: 'tenant-1' },
              m.access,
              { allowActive: true },
              { mandateEndedAt: null },
              { anonymizedAt: null },
            ],
          },
          { id: { in: [CLIENT_ID, HIDDEN_ID] } },
        ],
      },
      select: expect.objectContaining({ id: true, name: true }),
    });
  });

  it('berechnet Vorschläge per Datenbankabfrage über Kontaktadressen', async () => {
    const html = await render();
    expect(html).toContain('Unbestätigte Zuordnungsvorschläge aus Kontaktadressen: Kunde GmbH');
    expect(m.contactFindMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        active: true,
        email: { in: ['kunde@example.test', 'kanzlei@example.test'] },
        client: {
          AND: [
            m.access,
            { tenantId: 'tenant-1', allowActive: true, anonymizedAt: null, mandateEndedAt: null },
          ],
        },
      },
      select: { email: true, client: { select: { id: true, name: true } } },
    });
  });
});
