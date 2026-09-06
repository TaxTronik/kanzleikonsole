// Fachkatalog: ACCESS-TENANT-RLS-001.
// Real contact actions, HMAC tokens and HTTP feed handler; only persistence,
// authenticated staff context and external side effects are simulated.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const CONTACT_ID = '0b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_CONTACT_ID = 'a6b899b6-d2a0-4267-a27c-a339fbfbc456';
const CLIENT_ID = '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f';

type Contact = {
  id: string;
  tenantId: string;
  clientId: string;
  email: string;
  fullName: string;
  phone: null;
  role: null;
  active: boolean;
  icalTokenVersion: number;
  lastLoginAt: Date | null;
};

const m = vi.hoisted(() => ({
  contacts: new Map<string, Contact>(),
  evidenceRecord: vi.fn(),
  revokeAllSessions: vi.fn(),
  deadlineFindMany: vi.fn(),
  appointmentFindMany: vi.fn(),
  assertClientAccessTx: vi.fn(),
  withTenantContext: vi.fn(),
  tx: {
    client: { findUnique: vi.fn() },
    clientContact: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/config', () => ({ env: { AUTH_SECRET: 'synthetic-ical-regression-secret' } }));
vi.mock('@taxtronik/tax', () => ({ SCHEDULE_LABELS: {} }));
vi.mock('@taxtronik/db/tenant-modules', () => ({
  readBooleanTenantModules: async () => ({ taxNotices: true, appointments: true }),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/auth/magic-link', () => ({ requestMagicLink: vi.fn() }));
vi.mock('@/server/auth/revocation', () => ({ revokeAllSessions: m.revokeAllSessions }));
vi.mock('@/server/mail/dispatch', () => ({ sendTemplateMail: vi.fn() }));
vi.mock('@/server/util/fire-and-forget', () => ({ fireAndForget: vi.fn() }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: vi.fn() }));
vi.mock('@/server/gwg-onboarding/service', () => ({
  generateInviteToken: vi.fn(),
  INVITE_TTL_DAYS: 7,
}));
vi.mock('@/server/gwg-onboarding/invite-lifecycle', () => ({ prepareGwgInviteIssueTx: vi.fn() }));
vi.mock('@/server/gwg-onboarding/invite-binding', () => ({ prepareGwgInviteBindingTx: vi.fn() }));
vi.mock('@/server/gwg/reverification', () => ({ lockGwgCheckLifecycleTx: vi.fn() }));
vi.mock('@/server/gwg/professional-review', () => ({ isGwgProfessionallyReviewed: vi.fn() }));
vi.mock('@/server/gwg-onboarding/manual-capture', () => ({ startManualGwgCaptureTx: vi.fn() }));
vi.mock('@/server/auth/rbac', () => ({
  toActionError: (e: Error) => ({ ok: false, error: e.message }),
  assertClientAccessTx: m.assertClientAccessTx,
}));
vi.mock('@/server/actions/staff-action', async () => {
  const { parseFormData } = await import('@/server/actions/form-data');
  const staff = {
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
    session: {},
  };
  return {
    ActionError: class extends Error {},
    parseFormData,
    staffActionGuard: async () => staff,
    withStaff: async (fn: (tx: unknown, ctx: unknown) => Promise<unknown>) => {
      try {
        await m.withTenantContext(staff.ctx, (tx: unknown) => fn(tx, staff));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
  };
});
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    clientContact: {
      findFirst: async ({ where }: { where: { id: string; active: boolean } }) => {
        const contact = m.contacts.get(where.id);
        return contact && contact.active === where.active
          ? {
              ...contact,
              client: {
                name: 'Synthetic client',
                allowActive: true,
                anonymizedAt: null,
                mandateEndedAt: null,
              },
            }
          : null;
      },
    },
    taxDeadline: { findMany: m.deadlineFindMany },
    appointment: { findMany: m.appointmentFindMany },
  },
}));

import { deactivateContactAction, inviteContactAction, updateContactAction } from '../actions';
import { onboardingAddContactAction } from '@/app/staff/(protected)/clients/onboarding/[id]/actions';
import { signIcalToken } from '@/server/ical/feed';
import { GET } from '@/app/api/portal/ical/[token]/route';

beforeEach(() => {
  vi.resetAllMocks();
  m.contacts.clear();
  for (const id of [CONTACT_ID, OTHER_CONTACT_ID]) {
    m.contacts.set(id, {
      id,
      tenantId: 'tenant-1',
      clientId: CLIENT_ID,
      email: id === CONTACT_ID ? 'old@example.test' : 'other@example.test',
      fullName: 'Synthetic contact',
      phone: null,
      role: null,
      active: true,
      icalTokenVersion: 3,
      lastLoginAt: new Date('2026-09-01T12:00:00Z'),
    });
  }
  m.withTenantContext.mockImplementation(async (_ctx, fn) => {
    const snapshot = structuredClone(m.contacts);
    try {
      return await fn(m.tx);
    } catch (error) {
      m.contacts = snapshot;
      throw error;
    }
  });
  m.tx.client.findUnique.mockResolvedValue({ allowActive: true });
  m.tx.clientContact.findUnique.mockImplementation(async ({ where }) => {
    const contact = m.contacts.get(where.id);
    return contact ? structuredClone(contact) : null;
  });
  m.tx.clientContact.findFirst.mockImplementation(async ({ where }) => {
    const contact = [...m.contacts.values()].find(
      (row) =>
        row.tenantId === where.tenantId &&
        row.clientId === where.clientId &&
        row.email === where.email &&
        row.id !== where.id?.not,
    );
    return contact ? structuredClone(contact) : null;
  });
  m.tx.clientContact.update.mockImplementation(async ({ where, data }) => {
    const contact = m.contacts.get(where.id)!;
    const { icalTokenVersion, ...fields } = data;
    Object.assign(contact, fields);
    if (icalTokenVersion) contact.icalTokenVersion += icalTokenVersion.increment;
    return structuredClone(contact);
  });
  m.deadlineFindMany.mockResolvedValue([]);
  m.appointmentFindMany.mockResolvedValue([
    {
      id: 'appointment-1',
      title: 'Confidential planning meeting',
      startsAt: new Date('2026-10-01T10:00:00Z'),
      endsAt: new Date('2026-10-01T11:00:00Z'),
      location: 'Private meeting room',
    },
  ]);
});

function feed(token = signIcalToken(CONTACT_ID, 3)) {
  return GET({} as NextRequest, { params: Promise.resolve({ token }) });
}

function update(email: string) {
  return updateContactAction({
    contactId: CONTACT_ID,
    clientId: CLIENT_ID,
    fullName: 'Updated synthetic contact',
    email,
  });
}

describe('contact identity changes revoke independent iCal capabilities', () => {
  it('rejects the old signed feed after email replacement and permits a newly issued feed', async () => {
    expect(await (await feed()).text()).toContain('Confidential planning meeting');
    expect(await update('new@example.test')).toEqual({ ok: true });
    m.appointmentFindMany.mockClear();
    m.deadlineFindMany.mockClear();

    expect((await feed()).status).toBe(404);
    expect(m.appointmentFindMany).not.toHaveBeenCalled();
    expect(m.deadlineFindMany).not.toHaveBeenCalled();
    expect(
      (await feed(signIcalToken(CONTACT_ID, m.contacts.get(CONTACT_ID)!.icalTokenVersion))).status,
    ).toBe(200);
    expect((await feed(signIcalToken(OTHER_CONTACT_ID, 3))).status).toBe(200);
  });

  it('does not resurrect a former subscription after deactivation and re-invitation', async () => {
    const form = new FormData();
    form.set('contactId', CONTACT_ID);
    form.set('clientId', CLIENT_ID);
    await deactivateContactAction(form);
    expect((await feed()).status).toBe(404);

    form.set('email', 'old@example.test');
    form.set('fullName', 'Reactivated synthetic contact');
    expect(await inviteContactAction(null, form)).toEqual({ ok: true });
    expect(m.contacts.get(CONTACT_ID)!.active).toBe(true);
    m.appointmentFindMany.mockClear();

    expect((await feed()).status).toBe(404);
    expect(m.appointmentFindMany).not.toHaveBeenCalled();
    expect(
      (await feed(signIcalToken(CONTACT_ID, m.contacts.get(CONTACT_ID)!.icalTokenVersion))).status,
    ).toBe(200);
  });

  it('retains the subscription for a cosmetic update with unchanged normalized email', async () => {
    expect(await update('OLD@example.test')).toEqual({ ok: true });
    expect((await feed()).status).toBe(200);
    expect(m.contacts.get(CONTACT_ID)!.icalTokenVersion).toBe(3);
    expect(m.revokeAllSessions).not.toHaveBeenCalled();
  });

  it.each(['contacts', 'onboarding'])(
    'invalidates legacy subscriptions when an inactive contact is reactivated via %s',
    async (entryPoint) => {
      m.contacts.get(CONTACT_ID)!.active = false;
      const form = new FormData();
      form.set('clientId', CLIENT_ID);
      form.set('email', 'old@example.test');
      form.set('fullName', 'Reactivated synthetic contact');
      if (entryPoint === 'contacts') {
        expect(await inviteContactAction(null, form)).toEqual({ ok: true });
      } else {
        await expect(onboardingAddContactAction(form)).rejects.toThrow(
          `NEXT_REDIRECT:/staff/clients/onboarding/${CLIENT_ID}?step=gwg`,
        );
      }
      expect(m.contacts.get(CONTACT_ID)!.active).toBe(true);
      expect((await feed()).status).toBe(404);
      expect(m.appointmentFindMany).not.toHaveBeenCalled();
    },
  );

  it('does not change identity or revoke a feed when the client authorization fails', async () => {
    m.assertClientAccessTx.mockRejectedValueOnce(new Error('Kein Zugriff auf diesen Mandanten.'));
    expect(await update('new@example.test')).toEqual({
      ok: false,
      error: 'Kein Zugriff auf diesen Mandanten.',
    });
    expect(m.tx.clientContact.update).not.toHaveBeenCalled();
    expect(m.revokeAllSessions).not.toHaveBeenCalled();
    expect((await feed()).status).toBe(200);
  });
});
