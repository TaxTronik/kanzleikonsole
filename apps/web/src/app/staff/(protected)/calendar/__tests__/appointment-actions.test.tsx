// Review-Befund C1: Termine bearbeiten und absagen statt löschen.
//
// Belegt die Server-Actions — die Absage ist ein eigener, auditierter
// CAS-Schritt; ein abgesagter Termin bleibt abgesagt — und dass die Vorbelegung
// des Bearbeiten-Dialogs unverändert durch dieselbe Validierung kommt (die
// Berlin-Wanduhrzeit trifft wieder denselben Instant).

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@/server/actions/action-error';
import { toActionError } from '@/server/actions/to-action-error';

const h = vi.hoisted(() => ({
  currentTx: null as unknown,
  withStaff: vi.fn(),
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
  enqueueDirectMailTx: vi.fn(),
  kickMailOutboxDelivery: vi.fn(),
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
vi.mock('@/server/actions/staff-action', async () => ({
  ActionError: (await import('@/server/actions/action-error')).ActionError,
  withStaffModule: () => h.withStaff,
  // Echte FormData-Prüfung statt einer Attrappe (gleiche Validierung wie im Betrieb).
  parseFormData: (
    await vi.importActual<typeof import('@/server/actions/form-data')>('@/server/actions/form-data')
  ).parseFormData,
}));
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
    fromRequestId: REQUEST,
    ...overrides,
  };
}

function appointmentTx(row: unknown, count = 1) {
  const tx = {
    appointment: {
      findUnique: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockResolvedValue({ count }),
      delete: vi.fn(),
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

    expect(result).toEqual({ ok: true });
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
    expect(h.withStaff.mock.calls[0]![1]).toEqual({
      revalidate: ['/staff/calendar', '/staff/tax-deadlines', '/portal/appointments'],
    });
    // Keine Absage-Mail: Ob und wie der Mandant informiert wird, ist offen.
    expect(h.notify).not.toHaveBeenCalled();
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

    await expect(cancelAppointmentAction({ id: APPOINTMENT_ID })).resolves.toEqual({ ok: true });
    expect(h.assertClientAccessTx).not.toHaveBeenCalled();
    expect(tx.appointment.updateMany).toHaveBeenCalledTimes(1);
  });

  it('weist unbekannte Termine und ungültige IDs ab', async () => {
    appointmentTx(null);
    await expect(cancelAppointmentAction({ id: APPOINTMENT_ID })).resolves.toEqual({
      ok: false,
      error: 'Termin nicht gefunden.',
    });

    h.withStaff.mockClear();
    await expect(cancelAppointmentAction({ id: 'kein-termin' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
    });
    expect(h.withStaff).not.toHaveBeenCalled();
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
    expect(h.withStaff).not.toHaveBeenCalled();
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

    expect(result).toEqual({ ok: true });
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
    if (attrs['name'] && !('disabled' in attrs)) form.append(attrs['name'], attrs['value'] ?? '');
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
