// Review-Entscheidung C4: Der Zustellstatus der Bestätigungs- bzw. Absagemail
// steht dort, wo die Terminanfrage entschieden wurde — im Kanzleikalender,
// auch nachdem die Anfrage die offene Liste verlassen hat.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/server/mail/resend-actions', () => ({ resendMailOutboxAction: vi.fn() }));

import { DecidedRequests } from '../decided-requests';

describe('Entschiedene Terminanfragen im Kalender', () => {
  it('zeigt Entscheidung, Zustellstatus und „Erneut senden“ je Anfrage', () => {
    const html = renderToStaticMarkup(
      <DecidedRequests
        days={14}
        requests={[
          {
            id: 'request-1',
            subject: 'Jahresgespräch',
            clientName: 'Müller GmbH',
            status: 'ACCEPTED',
            decidedAt: new Date('2026-10-06T08:00:00.000Z'),
            mail: [
              {
                purpose: 'appointment-confirmed',
                state: 'failed',
                accepted: 0,
                attempted: 1,
                resend: {
                  purpose: 'appointment-confirmed',
                  resourceType: 'appointment_request',
                  resourceId: 'request-1',
                  outboxIds: ['outbox-1'],
                  uncertain: false,
                },
              },
            ],
          },
          {
            id: 'request-2',
            subject: 'Rückfrage',
            clientName: 'Schmidt',
            status: 'REJECTED',
            decidedAt: new Date('2026-10-05T08:00:00.000Z'),
            mail: [],
          },
        ]}
      />,
    );

    expect(html).toContain('Entschiedene Terminanfragen (letzte 14 Tage)');
    expect(html).toContain('Jahresgespräch');
    expect(html).toContain('angenommen am 06.10.26, 10:00');
    expect(html).toContain('Terminbestätigung: Versand fehlgeschlagen – bitte prüfen');
    expect(html).toContain('Erneut senden');
    expect(html).toContain('abgelehnt am 05.10.26, 10:00');
    expect(html).toContain('Keine Mail – der anfragende Kontakt ist inaktiv');
  });

  it('rendert ohne Entscheidungen nichts', () => {
    expect(renderToStaticMarkup(<DecidedRequests days={14} requests={[]} />)).toBe('');
  });

  // Laden der entschiedenen Anfragen (Zeitraum, Sichtbarkeit, Zustellstatus)
  // prüft page-render.test.tsx am gerenderten Kalender (B-08).
});
