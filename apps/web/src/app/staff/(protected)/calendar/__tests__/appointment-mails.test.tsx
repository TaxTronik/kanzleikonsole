// Fachkatalog: MAIL-OUTBOX-001
// Welle 15: Der Zustellstatus der Mails zu Terminänderungen und -absagen steht
// im Kanzleikalender wie der der Entscheidungsmails, mit „Erneut senden“.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/server/mail/resend-actions', () => ({ resendMailOutboxAction: vi.fn() }));

import { AppointmentMails } from '../appointment-mails';

const page = readFileSync(resolve(__dirname, '../page.tsx'), 'utf8');

describe('Mandanten-Mails zu Terminänderungen im Kalender', () => {
  it('zeigt Termin, Zustand und Zustellstatus samt „Erneut senden“', () => {
    const html = renderToStaticMarkup(
      <AppointmentMails
        days={14}
        appointments={[
          {
            id: 'appointment-1',
            title: 'Jahresgespräch',
            clientName: 'Müller GmbH',
            status: 'CANCELLED',
            startsAt: new Date('2026-10-20T08:00:00.000Z'),
            mail: [
              {
                purpose: 'appointment-cancelled',
                state: 'failed',
                accepted: 0,
                attempted: 1,
                resend: {
                  purpose: 'appointment-cancelled',
                  resourceType: 'appointment',
                  resourceId: 'appointment-1',
                  outboxIds: ['outbox-1'],
                  uncertain: false,
                },
              },
            ],
          },
          {
            id: 'appointment-2',
            title: 'Vorgespräch',
            clientName: null,
            status: 'CONFIRMED',
            startsAt: new Date('2026-10-21T12:00:00.000Z'),
            mail: [
              { purpose: 'appointment-changed', state: 'accepted', accepted: 2, attempted: 2 },
            ],
          },
        ]}
      />,
    );

    expect(html).toContain('Mandanten-Mails zu Terminänderungen (letzte 14 Tage)');
    expect(html).toContain('data-appointment-mail="appointment-1"');
    expect(html).toContain('abgesagt · 20.10.26, 10:00');
    expect(html).toContain('Absage des Termins: Versand fehlgeschlagen – bitte prüfen');
    expect(html).toContain('Erneut senden');
    expect(html).toContain('Terminänderung: vom Versanddienst angenommen');
  });

  it('rendert ohne Terminmitteilungen nichts', () => {
    expect(renderToStaticMarkup(<AppointmentMails days={14} appointments={[]} />)).toBe('');
  });

  it('lädt die Mitteilungen des Zeitraums mit derselben Mandantensichtbarkeit wie die Termine', () => {
    expect(page).toContain("resourceType: 'appointment',");
    expect(page).toContain('purpose: { in: APPOINTMENT_MAIL_PURPOSES }');
    expect(page).toContain('createdAt: { gte: decidedSince }');
    const mailed = page.slice(page.indexOf('const mailedAppointments'));
    expect(mailed.slice(0, 500)).toContain('...optionalClientAccessFilter(clientAccess)');
    // Empfänger der Checkbox nur für aktive Termine.
    expect(page).toContain(
      "appointments.filter((appointment) => appointment.status !== 'CANCELLED')",
    );
  });
});
