// Review-Entscheidung C4: Der Zustellstatus der Bestätigungs- bzw. Absagemail
// steht dort, wo die Terminanfrage entschieden wurde — im Kanzleikalender,
// auch nachdem die Anfrage die offene Liste verlassen hat.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/server/mail/resend-actions', () => ({ resendMailOutboxAction: vi.fn() }));

import { DecidedRequests } from '../decided-requests';

const page = readFileSync(resolve(__dirname, '../page.tsx'), 'utf8');

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

  it('lädt entschiedene Anfragen des Zeitraums samt Zustellstatus der Terminmails', () => {
    expect(page).toContain("status: { in: ['ACCEPTED', 'REJECTED'] }");
    expect(page).toContain('decidedAt: { gte: decidedSince }');
    expect(page).toContain('new Date().getTime() - DECIDED_REQUEST_DAYS * 86_400_000');
    expect(page).toContain("resourceType: 'appointment_request'");
    // Dieselbe Mandantensichtbarkeit wie die offenen Anfragen.
    const decided = page.slice(page.indexOf("status: { in: ['ACCEPTED', 'REJECTED'] }"));
    expect(decided.slice(0, 400)).toContain('...viaVisibleClient');
  });
});
