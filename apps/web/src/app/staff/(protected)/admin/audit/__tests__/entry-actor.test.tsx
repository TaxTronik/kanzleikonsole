// @vitest-environment jsdom
// Audit-Eintrag: Akteur als Render-Test gegen eine nachgebildete Tenant-Tx
// (B-08, Welle 15) statt Quelltextprüfung.
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';

const ACTOR_ID = '5f0c2a8e-1b7d-4c3e-9a6f-0d2b4e8c1a37';

const h = vi.hoisted(() => ({
  entry: null as Record<string, unknown> | null,
  staffFindFirst: vi.fn(),
}));

vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['ADMIN'] },
  })),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      auditLog: {
        findFirst: vi.fn(async ({ where }: { where: { id: unknown } }) =>
          typeof where.id === 'bigint' ? h.entry : null,
        ),
      },
      staffUser: { findFirst: h.staffFindFirst },
    }),
  ),
}));

import AuditEntryPage from '../[id]/page';

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 42n,
    tenantId: 'tenant-1',
    occurredAt: new Date('2026-10-01T08:00:00.000Z'),
    actorType: 'STAFF',
    actorId: ACTOR_ID,
    action: 'client.update',
    resourceType: 'client',
    resourceId: 'client-1',
    before: null,
    after: null,
    ip: null,
    userAgent: null,
    prevHash: Buffer.alloc(32),
    thisHash: Buffer.alloc(32, 1),
    ...overrides,
  };
}

async function render() {
  return renderServer(AuditEntryPage({ params: Promise.resolve({ id: '42' }) }));
}

function actorCell(): HTMLElement {
  return screen.getByText('Akteur').nextElementSibling as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.entry = entry();
  h.staffFindFirst.mockResolvedValue({ fullName: 'Erika Muster' });
});

describe('audit entry actor', () => {
  it('löst Mitarbeitende im Tenant per Name auf und zeigt die vollständige Akteur-ID', async () => {
    await render();
    expect(h.staffFindFirst).toHaveBeenCalledWith({
      where: { id: ACTOR_ID, tenantId: 'tenant-1' },
      select: { fullName: true },
    });
    const cell = actorCell();
    expect(cell.textContent).toContain('Mitarbeiter');
    expect(screen.getByText('Erika Muster')).toBeTruthy();
    const id = screen.getByText(ACTOR_ID);
    expect(id.parentElement).toBe(cell);
    expect([...id.classList]).toEqual(expect.arrayContaining(['block', 'break-all', 'font-mono']));
  });

  it('sucht für andere Akteurtypen keinen Mitarbeitendennamen', async () => {
    h.entry = entry({ actorType: 'CLIENT_CONTACT' });
    await render();
    expect(h.staffFindFirst).not.toHaveBeenCalled();
    expect(actorCell().textContent).toBe(`Mandant${ACTOR_ID}`);
  });
});
