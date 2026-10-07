// Review-Befund C1: Kalender-UI für „Termin bearbeiten" und „Termin absagen".
//
// Kein DOM in der Testumgebung: Die Tests rendern serverseitig, fangen die Props
// der gerenderten <button> ab und rufen Handler direkt auf. useActionState und
// useTransition werden so ersetzt, dass die Aufrufe der Server-Actions sichtbar
// werden.

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  buttons: [] as Array<Record<string, unknown>>,
  reducers: [] as Array<(previous: unknown, data: FormData) => Promise<unknown>>,
  transitions: [] as Array<Promise<unknown>>,
  refresh: vi.fn(),
  updateAppointmentAction: vi.fn(),
  cancelAppointmentAction: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useActionState: (reducer: (previous: unknown, data: FormData) => Promise<unknown>) => {
      probe.reducers.push(reducer);
      return [null, () => undefined, false] as const;
    },
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

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: probe.refresh }) }));
vi.mock('../actions', () => ({
  updateAppointmentAction: probe.updateAppointmentAction,
  cancelAppointmentAction: probe.cancelAppointmentAction,
}));
// Ohne DOM rendert das Portal nichts; der Inhalt steht hier direkt im Markup.
vi.mock('@/components/ui/modal', () => ({
  Modal: ({ children, title }: { children: ReactNode; title: string }) => (
    <div role="dialog" aria-label={title}>
      {children}
    </div>
  ),
}));

const { AppointmentPills, editableAppointment, sortCancelledLast } =
  await import('../appointment-pills');
const { AppointmentEditModal, ownerOptionsFor, APPOINTMENT_NOT_NOTIFIED_HINT } =
  await import('../edit-appointment-dialog');
type CalendarAppointment = import('../appointment-pills').CalendarAppointment;

const OWNER = '22222222-2222-4222-8222-222222222222';
const STAFF = [{ id: OWNER, fullName: 'Erika Beispiel' }];

function row(overrides: Partial<CalendarAppointment> = {}): CalendarAppointment {
  return {
    id: 'appointment-1',
    title: 'Jahresgespräch',
    kind: 'CLIENT_MEETING',
    status: 'CONFIRMED',
    ownerStaffId: OWNER,
    owner: { fullName: 'Erika Beispiel' },
    client: { id: 'client-1', name: 'Müller GmbH' },
    // 10:00–11:30 Berlin (CEST)
    startsAt: new Date('2026-10-20T08:00:00.000Z'),
    endsAt: new Date('2026-10-20T09:30:00.000Z'),
    location: 'Büro',
    notes: null,
    fromRequestId: null,
    ...overrides,
  };
}

function modal(overrides: Partial<CalendarAppointment> = {}, onClose = vi.fn()) {
  const appointment = row(overrides);
  const html = renderToStaticMarkup(
    <AppointmentEditModal
      appointment={editableAppointment(appointment, 'CONFIRMED')}
      staffOptions={STAFF}
      onClose={onClose}
    />,
  );
  return { html, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  probe.buttons = [];
  probe.reducers = [];
  probe.transitions = [];
});

describe('Terminpillen im Kanzleikalender', () => {
  it('öffnet aktive Termine zum Bearbeiten und zeigt abgesagte durchgestrichen ohne Aktion', () => {
    const html = renderToStaticMarkup(
      <AppointmentPills
        appointments={[
          row({ id: 'cancelled', status: 'CANCELLED', startsAt: new Date('2026-10-20T07:00:00Z') }),
          row({ id: 'active' }),
        ]}
        staffOptions={STAFF}
        limit={3}
      />,
    );

    expect(html).toContain('data-appointment-edit="active"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain(
      'title="10:00 – 11:30: Jahresgespräch · Müller GmbH — bearbeiten oder absagen"',
    );
    expect(html).not.toContain('data-appointment-edit="cancelled"');
    expect(html).toContain('class="cal-pill cal-pill-cancelled"');
    expect(html).toContain('title="Abgesagt — 09:00 – 11:30: Jahresgespräch · Müller GmbH"');
    expect(html).toMatch(/Abgesagt<\/span><s> · 09:00 · Müller GmbH · Jahresgespräch<\/s>/);
    // Der aktive Termin steht vor dem abgesagten, obwohl dieser früher beginnt.
    expect(html.indexOf('data-appointment-edit="active"')).toBeLessThan(
      html.indexOf('cal-pill-cancelled'),
    );
    // Keine Platzhalter-Links mehr für Termine ohne Mandant.
    expect(html).not.toContain('href="#"');
  });

  it('verdrängt mit abgesagten Terminen keine aktiven aus den Pillen eines Tages', () => {
    const appointments = [
      row({ id: 'c1', status: 'CANCELLED' }),
      row({ id: 'a1' }),
      row({ id: 'a2' }),
      row({ id: 'a3' }),
    ];
    expect(sortCancelledLast(appointments).map((a) => a.id)).toEqual(['a1', 'a2', 'a3', 'c1']);

    const html = renderToStaticMarkup(
      <AppointmentPills appointments={appointments} staffOptions={STAFF} limit={3} />,
    );
    expect(html.match(/data-appointment-edit=/g)).toHaveLength(3);
    expect(html).not.toContain('cal-pill-cancelled');
  });

  it('übergibt dem Dialog die Berlin-Wanduhrzeit und die Herkunft aus einer Terminanfrage', () => {
    expect(
      editableAppointment(row({ fromRequestId: 'request-1', notes: 'Notiz' }), 'PLANNED'),
    ).toEqual({
      id: 'appointment-1',
      title: 'Jahresgespräch',
      kind: 'CLIENT_MEETING',
      status: 'PLANNED',
      ownerStaffId: OWNER,
      ownerName: 'Erika Beispiel',
      client: { id: 'client-1', name: 'Müller GmbH' },
      startsAt: '2026-10-20T10:00',
      endsAt: '2026-10-20T11:30',
      location: 'Büro',
      notes: 'Notiz',
      fromRequest: true,
    });
  });
});

describe('Dialog „Termin bearbeiten"', () => {
  it('belegt alle Felder vor und bietet „abgesagt" nicht als Status an', () => {
    const { html } = modal({ fromRequestId: 'request-1' });

    expect(html).toContain('<input type="hidden" name="id" value="appointment-1"/>');
    expect(html).toMatch(/name="title"[^>]*value="Jahresgespräch"/);
    expect(html).toMatch(/name="startsAt"[^>]*value="2026-10-20T10:00"/);
    expect(html).toMatch(/name="endsAt"[^>]*value="2026-10-20T11:30"/);
    expect(html).toContain('<input type="hidden" name="clientId" value="client-1"/>');
    expect(html).toMatch(/<option value="CONFIRMED" selected="">Bestätigt<\/option>/);
    expect(html).toMatch(/<option value="CLIENT_MEETING" selected="">Mandantentermin<\/option>/);
    expect(html).not.toContain('value="CANCELLED"');
    expect(html).toContain(APPOINTMENT_NOT_NOTIFIED_HINT);
    expect(html).toContain('stammt aus einer Terminanfrage im Portal');
    expect(html).toContain('href="/staff/clients/client-1"');
    expect(html).toContain('Termin absagen …');
    expect(html).toContain('Absage bestätigen');
  });

  it('behält einen inzwischen deaktivierten Owner als Auswahl, statt still zu wechseln', () => {
    expect(ownerOptionsFor({ ownerStaffId: OWNER, ownerName: 'Erika Beispiel' }, STAFF)).toBe(
      STAFF,
    );
    expect(ownerOptionsFor({ ownerStaffId: 'old-owner', ownerName: 'Max Alt' }, STAFF)).toEqual([
      { id: 'old-owner', fullName: 'Max Alt (nicht mehr aktiv)' },
      ...STAFF,
    ]);
  });

  it('speichert über updateAppointmentAction und schließt erst nach Erfolg', async () => {
    const { onClose } = modal();
    expect(probe.reducers).toHaveLength(1);
    const data = new FormData();
    data.set('id', 'appointment-1');

    probe.updateAppointmentAction.mockResolvedValueOnce({
      ok: false,
      error: 'Bitte prüfen Sie die markierten Angaben.',
    });
    await probe.reducers[0]!(null, data);
    expect(probe.updateAppointmentAction).toHaveBeenLastCalledWith(null, data);
    expect(onClose).not.toHaveBeenCalled();
    expect(probe.refresh).not.toHaveBeenCalled();

    probe.updateAppointmentAction.mockResolvedValueOnce({ ok: true });
    await probe.reducers[0]!(null, data);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(probe.refresh).toHaveBeenCalledTimes(1);
  });

  it('sagt über cancelAppointmentAction ab und schließt erst nach Erfolg', async () => {
    const { onClose } = modal();
    const confirm = probe.buttons.find((props) => props['data-appointment-cancel']);
    expect(confirm?.['data-appointment-cancel']).toBe('appointment-1');

    probe.cancelAppointmentAction.mockResolvedValueOnce({
      ok: false,
      error: 'Der Termin ist bereits abgesagt.',
    });
    (confirm!['onClick'] as () => void)();
    await Promise.all(probe.transitions);
    expect(probe.cancelAppointmentAction).toHaveBeenLastCalledWith({ id: 'appointment-1' });
    expect(onClose).not.toHaveBeenCalled();

    probe.cancelAppointmentAction.mockResolvedValueOnce({ ok: true });
    (confirm!['onClick'] as () => void)();
    await Promise.all(probe.transitions);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(probe.refresh).toHaveBeenCalledTimes(1);
    expect(probe.updateAppointmentAction).not.toHaveBeenCalled();
  });
});
