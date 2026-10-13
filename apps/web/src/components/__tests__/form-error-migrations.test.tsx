// @vitest-environment jsdom
// Zentrale Formularfehler in den 0.3.0-Migrationspfaden als Verhaltenstest
// (B-08, Welle 15) statt Quelltextprüfung: Jeder Pfad zeigt nach einer
// abgelehnten Action die Fehlerzusammenfassung mit Sprunglink und verknüpft
// das betroffene Feld per aria-invalid/aria-describedby mit seiner Meldung.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ActionResult } from '@/server/actions/staff-action';

const h = vi.hoisted(() => ({
  createAppointment: vi.fn(),
  updateAppointment: vi.fn(),
  createAppointmentRequest: vi.fn(),
}));

const router = { refresh: vi.fn(), push: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/app/staff/(protected)/calendar/actions', () => ({
  createAppointmentAction: h.createAppointment,
  updateAppointmentAction: h.updateAppointment,
  cancelAppointmentAction: vi.fn(),
}));
vi.mock('@/app/portal/(protected)/appointments/actions', () => ({
  createAppointmentRequestAction: h.createAppointmentRequest,
}));

import { NewRequestForm } from '../requests/new-request-form';
import { ClientContactsPanel } from '../client-contacts-panel';
import { NewAppointmentDialog } from '@/app/staff/(protected)/calendar/new-appointment-dialog';
import { AppointmentEditModal } from '@/app/staff/(protected)/calendar/edit-appointment-dialog';
import { AppointmentRequestForm } from '@/app/portal/(protected)/appointments/request-form';
import type { RequestActionResult } from '@/app/staff/(protected)/clients/[id]/requests/actions';

const STAFF = [{ id: 'staff-1', fullName: 'Erika Muster' }];
const MESSAGE = 'Bitte einen gültigen Wert angeben.';

function rejectWith(action: ReturnType<typeof vi.fn>, field: string) {
  action.mockResolvedValueOnce({
    ok: false,
    error: 'Validierung',
    fieldErrors: { [field]: [MESSAGE] },
  });
}

async function submit(form: HTMLFormElement) {
  await act(async () => {
    fireEvent.submit(form);
  });
}

/** Zusammenfassung mit Sprunglink und Feldverknüpfung für genau dieses Feld. */
function expectLinkedFieldError(form: HTMLFormElement, field: string) {
  const summary = within(form).getByRole('alert');
  const link = within(summary).getByRole('link', { name: MESSAGE });
  const target = form.ownerDocument.getElementById(link.getAttribute('href')!.slice(1));
  expect(target).not.toBeNull();
  const input = form.querySelector<HTMLElement>(`[name="${field}"]:not([type="hidden"])`)!;
  expect(target).toBe(input);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  const described = (input.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .map((id) => form.ownerDocument.getElementById(id)?.textContent);
  expect(described).toContain(MESSAGE);
}

function appointment() {
  return {
    id: 'appt-1',
    title: 'Jahresgespräch',
    kind: 'CLIENT_MEETING' as const,
    status: 'CONFIRMED' as const,
    ownerStaffId: 'staff-1',
    ownerName: 'Erika Muster',
    client: null,
    startsAt: '2026-10-20T10:00',
    endsAt: '2026-10-20T11:00',
    location: null,
    notes: null,
    fromRequest: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('zentrale Formularfehler in den 0.3.0-Migrationspfaden', () => {
  it('neue Anforderung nutzt Zusammenfassung und Feldverknüpfung', async () => {
    const action = vi.fn();
    rejectWith(action, 'title');
    const { container } = render(
      <NewRequestForm
        action={action}
        requestId="11111111-1111-4111-8111-111111111111"
        clientId="22222222-2222-4222-8222-222222222222"
        templates={[]}
        formTemplates={[]}
      />,
    );
    const form = container.querySelector('form')!;
    await submit(form);
    expect(action).toHaveBeenCalledOnce();
    expectLinkedFieldError(form, 'title');
  });

  it('Ansprechpartner nutzen Zusammenfassung und Feldverknüpfung', async () => {
    const invite = vi.fn();
    rejectWith(invite, 'email');
    render(
      <ClientContactsPanel
        clientId="client-1"
        contacts={[]}
        actions={{ invite, deactivate: vi.fn(), update: vi.fn(), rotateIcalToken: vi.fn() }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    const form = screen.getByLabelText('Name').closest('form')!;
    await submit(form);
    expectLinkedFieldError(form, 'email');
  });

  it('neuer Kanzleitermin nutzt Zusammenfassung und Feldverknüpfung', async () => {
    rejectWith(h.createAppointment, 'title');
    render(<NewAppointmentDialog staffOptions={STAFF} currentStaffId="staff-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Neuer Termin' }));
    const form = screen.getByRole('dialog').querySelector('form')!;
    await submit(form);
    expectLinkedFieldError(form, 'title');
  });

  it('Terminbearbeitung nutzt Zusammenfassung und Feldverknüpfung', async () => {
    rejectWith(h.updateAppointment, 'location');
    render(
      <AppointmentEditModal appointment={appointment()} staffOptions={STAFF} onClose={vi.fn()} />,
    );
    const form = screen.getByRole('dialog').querySelector('form')!;
    await submit(form);
    expectLinkedFieldError(form, 'location');
  });

  it('Terminanfrage im Portal nutzt Zusammenfassung und Feldverknüpfung', async () => {
    rejectWith(h.createAppointmentRequest, 'subject');
    render(<AppointmentRequestForm staffOptions={STAFF} />);
    fireEvent.click(screen.getByRole('button', { name: 'Anfragen' }));
    const form = screen.getByLabelText('Anliegen / Betreff').closest('form')!;
    await submit(form);
    expectLinkedFieldError(form, 'subject');
  });

  it('rendert in beiden Termindialogen die gemeinsamen Terminfelder', () => {
    const names = (form: HTMLFormElement) =>
      [...form.elements]
        .map((element) => (element as HTMLInputElement).name)
        .filter((name) => name && name !== 'appointmentId' && name !== 'expectedUpdatedAt');
    const created = render(<NewAppointmentDialog staffOptions={STAFF} currentStaffId="staff-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Neuer Termin' }));
    const createFields = names(screen.getByRole('dialog').querySelector('form')!);
    created.unmount();
    render(
      <AppointmentEditModal appointment={appointment()} staffOptions={STAFF} onClose={vi.fn()} />,
    );
    const editFields = names(screen.getByRole('dialog').querySelector('form')!);
    expect(createFields.length).toBeGreaterThan(5);
    expect(editFields).toEqual(
      expect.arrayContaining(createFields.filter((name) => name !== 'status')),
    );
  });

  it('bindet die neue Anforderung an REQ-LIFECYCLE-001 ohne lokalen ActionResult-Klon', () => {
    // Typprüfung (tsc): Das Ergebnis der Anforderungs-Actions baut auf dem
    // gemeinsamen ActionResult auf, statt einen eigenen Ergebnistyp zu pflegen.
    expectTypeOf<RequestActionResult>().toMatchTypeOf<ActionResult>();
    expectTypeOf<RequestActionResult['fieldErrors']>().toEqualTypeOf<ActionResult['fieldErrors']>();
    expectTypeOf<RequestActionResult['error']>().toEqualTypeOf<ActionResult['error']>();
  });
});
