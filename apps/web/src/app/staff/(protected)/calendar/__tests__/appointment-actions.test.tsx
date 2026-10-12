// Review-Befund C1: Termine bearbeiten und absagen statt löschen.
//
// Belegt die Server-Actions — die Absage ist ein eigener, auditierter
// CAS-Schritt; ein abgesagter Termin bleibt abgesagt — und dass die Vorbelegung
// des Bearbeiten-Dialogs unverändert durch dieselbe Validierung kommt (die
// Berlin-Wanduhrzeit trifft wieder denselben Instant).
//
// Fachkatalog: MAIL-OUTBOX-001
// Welle 15 („Checkbox im Dialog“): Mit „Mandant per E-Mail informieren“ legen
// Bearbeiten und Absagen je Empfänger einen Versandauftrag im selben Commit an;
// ohne Häkchen keine Mail; ohne erreichbaren Kontakt wird nichts gespeichert.
// Die Actions laufen über staffAction (echter Ablauf, gemocktes Gate).

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@/server/actions/action-error';
import { toActionError } from '@/server/actions/to-action-error';

const h = vi.hoisted(() => ({
  currentTx: null as unknown,
  withStaff: vi.fn(),
  guard: vi.fn(),
  withTenantContext: vi.fn(),
  revalidatePath: vi.fn(),
  enqueueDirectMailTx: vi.fn(),
  kickMailOutboxDelivery: vi.fn(),
  resolveNotificationsTx: vi.fn(),
  notify: vi.fn(),
  audit: vi.fn(),
  assertClientAccessTx: vi.fn(),
  canOtherStaffAccessClientTx: vi.fn(),
  assertClientInTenant: vi.fn(),
  assertStaffInTenant: vi.fn(),
}));

vi.mock('@taxtronik/db/notification', () => ({
  resolveNotificationsTx: h.resolveNotificationsTx,
}));
vi.mock('@/server/notifications/service', () => ({ notify: h.notify }));
vi.mock('@/server/mail/outbox', () => ({
  enqueueDirectMailTx: h.enqueueDirectMailTx,
  kickMailOutboxDelivery: h.kickMailOutboxDelivery,
}));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (ctx: unknown, run: (tx: unknown) => unknown) => {
    h.withTenantContext(ctx);
    return run(h.currentTx);
  },
}));
vi.mock('@/server/db/assert-tenant', () => ({
  assertClientInTenant: h.assertClientInTenant,
  assertStaffInTenant: h.assertStaffInTenant,
  TenantScopeError: class TenantScopeError extends Error {},
}));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: h.assertClientAccessTx,
  canOtherStaffAccessClientTx: h.canOtherStaffAccessClientTx,
}));
vi.mock('@/server/actions/audit', () => ({ audit: h.audit }));
vi.mock('@/server/actions/staff-action', async () => {
  const formData = await vi.importActual<typeof import('@/server/actions/form-data')>(
    '@/server/actions/form-data',
  );
  const runner = await vi.importActual<typeof import('@/server/actions/action-runner')>(
    '@/server/actions/action-runner',
  );
  return {
    ActionError: (await import('@/server/actions/action-error')).ActionError,
    withStaffModule: () => h.withStaff,
    // Echter Ablauf (Gate → Prüfung → Arbeit → Fehler-Mapping → Revalidate), Gate gemockt.
    staffAction: runner.createActionRunner(async (options?: unknown) => {
      h.guard(options);
      return { ok: true as const, ...staffContext() };
    }),
    // Echte FormData-Prüfung statt einer Attrappe (gleiche Validierung wie im Betrieb).
    parseFormData: formData.parseFormData,
    parseActionInput: formData.parseActionInput,
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
// Ohne DOM rendert das Portal nichts; der Inhalt steht hier direkt im Markup.
vi.mock('@/components/ui/modal', () => ({
  Modal: ({ children }: { children: ReactNode }) => <div data-modal="">{children}</div>,
}));

import { cancelAppointmentAction, updateAppointmentAction } from '../actions';
import { AppointmentEditModal } from '../edit-appointment-dialog';
import { editableAppointment, type CalendarAppointment } from '../appointment-pills';

const APPOINTMENT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const REQUEST = '55555555-5555-4555-8555-555555555555';
const CONTACT = '66666666-6666-4666-8666-666666666666';
const CONTACT_B = '77777777-7777-4777-8777-777777777777';
const REVALIDATED = ['/staff/calendar', '/staff/tax-deadlines', '/portal/appointments'];
const STARTS = new Date('2026-10-20T08:00:00.000Z'); // 10:00 Berlin (CEST)
const ENDS = new Date('2026-10-20T09:30:00.000Z');

function staffContext() {
  return {
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    session: {
      user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['ADMIN'], permissions: [] },
    },
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  };
}

function stored(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Jahresgespräch',
    status: 'CONFIRMED',
    clientId: CLIENT,
    ownerStaffId: OWNER,
    startsAt: STARTS,
    endsAt: ENDS,
    location: 'Büro',
    fromRequestId: REQUEST,
    ...overrides,
  };
}

function contact(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTACT,
    clientId: CLIENT,
    fullName: 'Erika Muster',
    email: 'erika@example.test',
    active: true,
    notificationsEnabled: true,
    ...overrides,
  };
}

function appointmentTx(
  row: unknown,
  count = 1,
  mail: {
    requestContact?: ReturnType<typeof contact> | null;
    contacts?: Array<ReturnType<typeof contact>>;
    anonymized?: boolean;
  } = {},
) {
  const tx = {
    appointment: {
      findUnique: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockResolvedValue({ count }),
      delete: vi.fn(),
    },
    // Empfänger der Mandanten-Mail (server/appointments/client-mail.ts, echt).
    client: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: CLIENT, anonymizedAt: mail.anonymized ? new Date('2026-10-01') : null },
        ]),
    },
    clientContact: { findMany: vi.fn().mockResolvedValue(mail.contacts ?? [contact()]) },
    appointmentRequest: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: REQUEST,
          clientId: CLIENT,
          createdByContactRel: mail.requestContact === undefined ? contact() : mail.requestContact,
        },
      ]),
    },
  };
  h.currentTx = tx;
  return tx;
}

function editForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  const fields: Record<string, string> = {
    id: APPOINTMENT_ID,
    title: 'Jahresgespräch',
    ownerStaffId: OWNER,
    clientId: CLIENT,
    kind: 'CLIENT_MEETING',
    status: 'CONFIRMED',
    startsAt: '2026-10-20T10:00',
    endsAt: '2026-10-20T11:30',
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.enqueueDirectMailTx.mockResolvedValue('outbox-1');
  h.withStaff.mockImplementation(async (run: (tx: unknown, ctx: unknown) => unknown) => {
    try {
      const data = await run(h.currentTx, staffContext());
      return { ok: true, ...(data ?? {}) };
    } catch (error) {
      return toActionError(error);
    }
  });
  h.resolveNotificationsTx.mockResolvedValue(1);
  h.audit.mockResolvedValue(undefined);
  h.notify.mockResolvedValue(undefined);
  h.assertClientAccessTx.mockResolvedValue(undefined);
  h.canOtherStaffAccessClientTx.mockResolvedValue(true);
  h.assertClientInTenant.mockResolvedValue(undefined);
  h.assertStaffInTenant.mockResolvedValue(undefined);
});

describe('cancelAppointmentAction (Absagen statt Löschen)', () => {
  it('setzt CANCELLED bedingt, erledigt die Hinweise und auditiert den Vorher-Stand', async () => {
    const tx = appointmentTx(stored());

    const result = await cancelAppointmentAction({ id: APPOINTMENT_ID });

    expect(result).toEqual({ ok: true, clientMails: 0 });
    expect(h.guard).toHaveBeenCalledWith({ module: 'appointments' });
    expect(h.assertClientAccessTx).toHaveBeenCalledWith(tx, staffContext().session, CLIENT);
    expect(tx.appointment.updateMany).toHaveBeenCalledWith({
      where: { id: APPOINTMENT_ID, status: { not: 'CANCELLED' } },
      data: { status: 'CANCELLED' },
    });
    expect(tx.appointment.delete).not.toHaveBeenCalled();
    expect(h.resolveNotificationsTx).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-1',
      resources: [{ resourceType: 'appointment', resourceId: APPOINTMENT_ID }],
    });
    expect(h.audit).toHaveBeenCalledWith(tx, staffContext().ctx, {
      action: 'appointment.cancel',
      resourceType: 'appointment',
      resourceId: APPOINTMENT_ID,
      before: {
        title: 'Jahresgespräch',
        status: 'CONFIRMED',
        ownerStaffId: OWNER,
        clientId: CLIENT,
        startsAt: STARTS.toISOString(),
        endsAt: ENDS.toISOString(),
        fromRequestId: REQUEST,
      },
      after: { status: 'CANCELLED' },
    });
    // Das Portal blendet den Termin aus; die Seite wird mit aktualisiert.
    expect(h.revalidatePath.mock.calls.map(([path]) => path)).toEqual(REVALIDATED);
    // Ohne Häkchen keine Absage-Mail an den Mandanten.
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.enqueueDirectMailTx).not.toHaveBeenCalled();
    expect(h.kickMailOutboxDelivery).not.toHaveBeenCalled();
  });

  it('meldet einen bereits abgesagten Termin, ohne erneut zu schreiben oder zu auditieren', async () => {
    const tx = appointmentTx(stored({ status: 'CANCELLED' }));

    const result = await cancelAppointmentAction({ id: APPOINTMENT_ID });

    expect(result).toEqual({ ok: false, error: 'Der Termin ist bereits abgesagt.' });
    expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('lässt bei einer parallelen Absage nur einen Statuswechsel samt Audit zu', async () => {
    appointmentTx(stored(), 0);

    const result = await cancelAppointmentAction({ id: APPOINTMENT_ID });

    expect(result).toEqual({ ok: false, error: 'Der Termin ist bereits abgesagt.' });
    expect(h.resolveNotificationsTx).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('prüft den Mandantenzugriff vor jeder Statusauskunft', async () => {
    const tx = appointmentTx(stored({ status: 'CANCELLED' }));
    h.assertClientAccessTx.mockRejectedValueOnce(new ForbiddenError('Kein Zugriff.'));

    const result = await cancelAppointmentAction({ id: APPOINTMENT_ID });

    expect(result).toEqual({ ok: false, error: 'Kein Zugriff.' });
    expect(tx.appointment.updateMany).not.toHaveBeenCalled();
  });

  it('sagt einen Termin ohne Mandantenbezug ohne Zugriffsventil ab', async () => {
    const tx = appointmentTx(stored({ clientId: null, fromRequestId: null }));

    await expect(cancelAppointmentAction({ id: APPOINTMENT_ID })).resolves.toEqual({
      ok: true,
      clientMails: 0,
    });
    expect(h.assertClientAccessTx).not.toHaveBeenCalled();
    expect(tx.appointment.updateMany).toHaveBeenCalledTimes(1);
  });

  it('weist unbekannte Termine und ungültige IDs ab', async () => {
    appointmentTx(null);
    await expect(cancelAppointmentAction({ id: APPOINTMENT_ID })).resolves.toEqual({
      ok: false,
      error: 'Termin nicht gefunden.',
    });

    h.withTenantContext.mockClear();
    await expect(cancelAppointmentAction({ id: 'kein-termin' })).resolves.toMatchObject({
      ok: false,
      error: 'Ungültige Termin-ID.',
      errorCode: 'VALIDATION_ERROR',
    });
    expect(h.withTenantContext).not.toHaveBeenCalled();
  });
});

describe('updateAppointmentAction (Bearbeiten-Dialog)', () => {
  it('nimmt CANCELLED nicht als Formularstatus an — abgesagt wird nur über die eigene Aktion', async () => {
    const result = await updateAppointmentAction(null, editForm({ status: 'CANCELLED' }));

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { status: ['Einen Termin sagen Sie über „Termin absagen“ ab.'] },
    });
    expect(h.withTenantContext).not.toHaveBeenCalled();
  });

  it('ändert einen abgesagten Termin nicht mehr', async () => {
    const tx = appointmentTx(stored({ status: 'CANCELLED' }));

    const result = await updateAppointmentAction(null, editForm());

    expect(result).toEqual({
      ok: false,
      error: 'Ein abgesagter Termin kann nicht mehr geändert werden.',
    });
    expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('überschreibt eine zwischenzeitliche Absage nicht mit dem alten Formularstatus', async () => {
    const tx = appointmentTx(stored(), 0);

    const result = await updateAppointmentAction(null, editForm({ status: 'PLANNED' }));

    expect(result).toEqual({
      ok: false,
      error: 'Ein abgesagter Termin kann nicht mehr geändert werden.',
    });
    expect(tx.appointment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: APPOINTMENT_ID, status: { not: 'CANCELLED' } } }),
    );
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('übernimmt die Vorbelegung des Dialogs unverändert durch dieselbe Validierung', async () => {
    const calendarRow: CalendarAppointment = {
      id: APPOINTMENT_ID,
      title: 'Jahresgespräch',
      kind: 'CLIENT_MEETING',
      status: 'CONFIRMED',
      ownerStaffId: OWNER,
      owner: { fullName: 'Erika Beispiel' },
      client: { id: CLIENT, name: 'Müller GmbH' },
      startsAt: STARTS,
      endsAt: ENDS,
      location: 'Büro "Mitte" & Co',
      notes: 'Unterlagen <mitbringen>',
      fromRequestId: REQUEST,
      clientMail: { recipients: [], unavailableReason: 'Der Mandant ist anonymisiert.' },
    };
    const html = renderToStaticMarkup(
      <AppointmentEditModal
        appointment={editableAppointment(calendarRow, 'CONFIRMED')}
        staffOptions={[{ id: OWNER, fullName: 'Erika Beispiel' }]}
        onClose={() => undefined}
      />,
    );
    const tx = appointmentTx(stored());

    const result = await updateAppointmentAction(null, submittedFormData(html));

    expect(result).toEqual({ ok: true, clientMails: 0 });
    expect(tx.appointment.updateMany).toHaveBeenCalledWith({
      where: { id: APPOINTMENT_ID, status: { not: 'CANCELLED' } },
      data: {
        title: 'Jahresgespräch',
        ownerStaffId: OWNER,
        clientId: CLIENT,
        kind: 'CLIENT_MEETING',
        status: 'CONFIRMED',
        startsAt: STARTS,
        endsAt: ENDS,
        location: 'Büro "Mitte" & Co',
        notes: 'Unterlagen <mitbringen>',
      },
    });
    expect(h.audit).toHaveBeenCalledWith(
      tx,
      staffContext().ctx,
      expect.objectContaining({ action: 'appointment.update', resourceId: APPOINTMENT_ID }),
    );
  });
});

describe('Welle 15: Mandant per E-Mail informieren', () => {
  const MOVED_STARTS = new Date('2026-10-21T12:00:00.000Z'); // 14:00 Berlin
  const MOVED_ENDS = new Date('2026-10-21T13:00:00.000Z');

  function moved(overrides: Record<string, string> = {}) {
    return editForm({ startsAt: '2026-10-21T14:00', endsAt: '2026-10-21T15:00', ...overrides });
  }

  it('legt bei Änderung mit Häkchen eine Terminänderung an den anfragenden Kontakt an', async () => {
    const tx = appointmentTx(stored());

    const result = await updateAppointmentAction(
      null,
      moved({ notifyClient: 'on', location: 'Büro', notes: 'intern: Mandant ist schwierig' }),
    );

    expect(result).toEqual({ ok: true, clientMails: 1 });
    expect(h.enqueueDirectMailTx).toHaveBeenCalledTimes(1);
    const [enqueueTx, target, mail] = h.enqueueDirectMailTx.mock.calls[0]!;
    expect(enqueueTx).toBe(tx);
    expect(target).toEqual({
      tenantId: 'tenant-1',
      clientId: CLIENT,
      purpose: 'appointment-changed',
      resource: { type: 'appointment', id: APPOINTMENT_ID },
      staffHref: '/staff/calendar',
      createdAt: expect.any(Date),
    });
    expect(mail).toMatchObject({
      slug: 'appointment-changed',
      to: 'erika@example.test',
      vars: {
        contact: { fullName: 'Erika Muster', email: 'erika@example.test' },
        appointment: {
          title: 'Jahresgespräch',
          startsAt: '21.10.2026, 14:00',
          endsAt: '15:00',
          location: 'Büro',
        },
      },
      relevance: {
        appointment: {
          startsAt: MOVED_STARTS.toISOString(),
          endsAt: MOVED_ENDS.toISOString(),
          title: 'Jahresgespräch',
          location: 'Büro',
        },
      },
    });
    // Keine internen Notizen in der Mail.
    expect(JSON.stringify(mail)).not.toContain('schwierig');
    // Versand erst nach dem Commit; im selben Commit auditiert.
    expect(h.kickMailOutboxDelivery).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      tx,
      staffContext().ctx,
      expect.objectContaining({
        action: 'appointment.update',
        after: expect.objectContaining({ clientMails: 1 }),
      }),
    );
  });

  it('sendet ohne Häkchen keine Mail, auch wenn ein Kontakt erreichbar wäre', async () => {
    const tx = appointmentTx(stored());

    const result = await updateAppointmentAction(null, moved());

    expect(result).toEqual({ ok: true, clientMails: 0 });
    expect(tx.appointment.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.clientContact.findMany).not.toHaveBeenCalled();
    expect(h.enqueueDirectMailTx).not.toHaveBeenCalled();
    expect(h.kickMailOutboxDelivery).not.toHaveBeenCalled();
  });

  it('speichert mit Häkchen ohne erreichbaren Kontakt nichts und markiert das Feld', async () => {
    const tx = appointmentTx(stored(), 1, {
      requestContact: contact({ notificationsEnabled: false }),
    });

    const result = await updateAppointmentAction(null, moved({ notifyClient: 'on' }));

    expect(result).toEqual({
      ok: false,
      error: 'Bitte prüfen Sie die markierten Angaben.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: {
        notifyClient: [
          'Der anfragende Kontakt ist nicht mehr vorhanden, inaktiv oder hat keine Benachrichtigungen aktiviert.',
        ],
      },
    });
    expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.enqueueDirectMailTx).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('teilt ohne Änderung an Titel, Zeit oder Ort nichts mit', async () => {
    const tx = appointmentTx(stored());

    const result = await updateAppointmentAction(
      null,
      editForm({ notifyClient: 'on', location: 'Büro', notes: 'nur Notiz geändert' }),
    );

    expect(result).toEqual({ ok: true, clientMails: 0 });
    expect(tx.appointment.updateMany).toHaveBeenCalledTimes(1);
    expect(h.enqueueDirectMailTx).not.toHaveBeenCalled();
  });

  it('informiert bei Terminen ohne Anfrage jeden erreichbaren Kontakt mit derselben Auslösung', async () => {
    appointmentTx(stored({ fromRequestId: null }), 1, {
      contacts: [
        contact(),
        contact({ id: CONTACT_B, fullName: 'Max Muster', email: 'max@example.test' }),
        contact({ id: 'inactive', email: 'alt@example.test', active: false }),
      ],
    });

    const result = await updateAppointmentAction(null, moved({ notifyClient: 'on' }));

    expect(result).toEqual({ ok: true, clientMails: 2 });
    const calls = h.enqueueDirectMailTx.mock.calls;
    expect(calls.map(([, , mail]) => mail.to)).toEqual(['erika@example.test', 'max@example.test']);
    expect(calls[0]![1].createdAt).toBe(calls[1]![1].createdAt);
  });

  it('legt beim Absagen mit Häkchen eine Absagemail an', async () => {
    const tx = appointmentTx(stored());

    const result = await cancelAppointmentAction({ id: APPOINTMENT_ID, notifyClient: true });

    expect(result).toEqual({ ok: true, clientMails: 1 });
    const [, target, mail] = h.enqueueDirectMailTx.mock.calls[0]!;
    expect(target).toMatchObject({
      purpose: 'appointment-cancelled',
      resource: { type: 'appointment', id: APPOINTMENT_ID },
    });
    expect(mail).toMatchObject({
      slug: 'appointment-cancelled',
      to: 'erika@example.test',
      vars: { appointment: { title: 'Jahresgespräch', startsAt: '20.10.2026, 10:00' } },
    });
    expect(mail).not.toHaveProperty('relevance');
    expect(tx.appointment.updateMany).toHaveBeenCalledTimes(1);
    expect(h.kickMailOutboxDelivery).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      tx,
      staffContext().ctx,
      expect.objectContaining({
        action: 'appointment.cancel',
        after: { status: 'CANCELLED', clientMails: 1 },
      }),
    );
  });

  it('sagt mit Häkchen bei Terminen ohne Mandantenbezug nicht ab, sondern markiert das Feld', async () => {
    const tx = appointmentTx(stored({ clientId: null, fromRequestId: null }));

    const result = await cancelAppointmentAction({ id: APPOINTMENT_ID, notifyClient: true });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { notifyClient: ['Der Termin hat keinen Mandantenbezug.'] },
    });
    expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    expect(h.enqueueDirectMailTx).not.toHaveBeenCalled();
  });
});

// --- Formular-Auswertung wie beim Absenden im Browser ------------------------

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of source.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)) {
    result[match[1]!] = decode(match[2] ?? '');
  }
  return result;
}

/** Felder, die der Browser beim Absenden des gerenderten Formulars schicken würde. */
function submittedFormData(html: string): FormData {
  const form = new FormData();
  for (const [tag] of html.matchAll(/<input\b[^>]*>/g)) {
    const attrs = attributes(tag.slice('<input'.length));
    if (!attrs['name'] || 'disabled' in attrs) continue;
    // Nicht angehakte Checkboxen sendet der Browser nicht.
    if (attrs['type'] === 'checkbox' && !('checked' in attrs)) continue;
    form.append(attrs['name'], attrs['value'] ?? 'on');
  }
  for (const match of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const attrs = attributes(match[1]!);
    const options = [...match[2]!.matchAll(/<option\b([^>]*)>/g)].map((o) => attributes(o[1]!));
    const selected = options.find((option) => 'selected' in option) ?? options[0];
    if (attrs['name'] && selected) form.append(attrs['name'], selected['value'] ?? '');
  }
  for (const match of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const attrs = attributes(match[1]!);
    if (attrs['name']) form.append(attrs['name'], decode(match[2]!));
  }
  return form;
}
