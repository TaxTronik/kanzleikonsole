// @vitest-environment jsdom
// Fachkatalog: APPT-BERLIN-WALLCLOCK-001, REQ-LIFECYCLE-001.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewAppointmentDialog } from '@/app/staff/(protected)/calendar/new-appointment-dialog';
import { AppointmentRequestForm } from '@/app/portal/(protected)/appointments/request-form';
import { NewRequestForm, type RequestTemplateOption } from '@/components/requests/new-request-form';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/staff/(protected)/calendar/actions', () => ({ createAppointmentAction: vi.fn() }));
vi.mock('@/app/portal/(protected)/appointments/actions', () => ({
  createAppointmentRequestAction: vi.fn(),
}));
// Der Portal-Einstieg lädt denselben DateTimePicker per next/dynamic.
vi.mock('next/dynamic', async () => {
  const { DateTimePicker } = await import('@/components/datetime-picker');
  return { default: () => DateTimePicker };
});

const template: RequestTemplateOption = {
  id: 'vorlage',
  name: 'Unterlagen',
  title: 'Bitte Unterlagen',
  description: 'Bitte hochladen.',
  category: null,
  priority: 'NORMAL',
  dueAfterDays: 1,
  formTemplateId: null,
};

function openRequestTemplate(days: number) {
  render(
    <NewRequestForm
      action={vi.fn()}
      requestId="anforderung"
      clientId="mandant"
      templates={[{ ...template, dueAfterDays: days }]}
      formTemplates={[]}
    />,
  );
  fireEvent.change(screen.getByLabelText('Vorlage anwenden'), { target: { value: template.id } });
  return screen.getByLabelText<HTMLInputElement>('Fällig am');
}

describe('Berliner Vorbelegungen bei Browserzeitzone UTC', () => {
  beforeEach(() => {
    vi.stubEnv('TZ', 'UTC');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-01T22:30:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('öffnet den neuen Kanzleitermin mit dem aktuellen Berliner Tag und der Berliner Stunde', () => {
    render(<NewAppointmentDialog staffOptions={[]} currentStaffId="mitarbeiter" />);
    fireEvent.click(screen.getByRole('button', { name: 'Neuer Termin' }));
    const form = screen.getByLabelText<HTMLInputElement>('Start').form!;
    expect(new FormData(form).get('startsAt')).toBe('2026-07-02T00:30');
    expect(new FormData(form).get('endsAt')).toBe('');
  });

  it('bietet im Portal morgen und übermorgen mit 10 bis 11 Uhr an', () => {
    render(<AppointmentRequestForm staffOptions={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Anfragen' }));
    const start = screen.getByLabelText<HTMLInputElement>('Beginn');
    expect(start.value).toBe('03.07.2026 10:00');
    const form = start.form!;
    fireEvent.click(within(form).getByRole('button', { name: 'Weiteren Wunschtermin hinzufügen' }));
    const data = new FormData(form);
    expect([data.get('slot0_starts'), data.get('slot0_ends')]).toEqual([
      '2026-07-03T10:00',
      '2026-07-03T11:00',
    ]);
    expect([data.get('slot1_starts'), data.get('slot1_ends')]).toEqual([
      '2026-07-04T10:00',
      '2026-07-04T11:00',
    ]);
    fireEvent.click(start);
    const july1 = document.querySelector('.react-datepicker__day--001');
    const july2 = document.querySelector('.react-datepicker__day--002');
    expect(july1?.getAttribute('aria-disabled')).toBe('true');
    expect(july2?.getAttribute('aria-disabled')).toBe('false');
  });

  it.each([
    ['2026-07-01T22:30:00Z', 1, '03.07.2026 00:30', '2026-07-03T00:30'],
    ['2026-03-28T22:30:00Z', 2, '30.03.2026 23:30', '2026-03-30T23:30'],
    ['2026-03-28T01:30:00Z', 1, '29.03.2026 03:30', '2026-03-29T03:30'],
  ] as const)(
    'übernimmt mit der Vorlage die Berliner Uhrzeit auch über die Zeitumstellung (%s)',
    (now, days, display, value) => {
      vi.setSystemTime(new Date(now));
      const due = openRequestTemplate(days);
      expect(due.value).toBe(display);
      expect(new FormData(due.form!).get('dueAt')).toBe(value);
    },
  );

  it('erhält eine gültige Berliner Vorlagenzeit in der fehlenden Stunde des Browsers', () => {
    vi.stubEnv('TZ', 'America/New_York');
    vi.setSystemTime(new Date('2026-03-07T01:30:00Z'));
    const due = openRequestTemplate(1);
    expect(due.value).toBe('2026-03-08T02:30');
    expect(new FormData(due.form!).get('dueAt')).toBe('2026-03-08T02:30');
    fireEvent.focus(due);
    fireEvent.change(due, { target: { value: '2026-03-08T02:45' } });
    expect(new FormData(due.form!).get('dueAt')).toBe('2026-03-08T02:45');
  });
});
