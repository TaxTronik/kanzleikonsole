// F-08: Zustellstatus einer Mandanten-Mail am Vorgang.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/server/mail/resend-actions', () => ({ resendMailOutboxAction: vi.fn() }));

import { MailDeliveryStatus, MailDeliveryStatusList } from '../mail-delivery-status';
import { MAIL_RESEND_UNCERTAIN_HINT } from '../mail-resend-button';

describe('MailDeliveryStatus', () => {
  it('nennt Anlass und Stand und erklärt, dass Annahme kein Zugangsnachweis ist', () => {
    const html = renderToStaticMarkup(
      <MailDeliveryStatus
        summary={{ purpose: 'invoice-sent', state: 'accepted', accepted: 2, attempted: 2 }}
      />,
    );

    expect(html).toContain('Rechnungsmail: vom Versanddienst angenommen (2 Empfänger)');
    expect(html).toContain('kein Zugangs- oder Kenntnisnahmenachweis');
    expect(html).toContain('data-mail-delivery="accepted"');
  });

  it('zeigt Teilzustellung mit Zählern und Fehlschläge ohne Erfolgsfarbe', () => {
    const partial = renderToStaticMarkup(
      <MailDeliveryStatus
        summary={{ purpose: 'request-opened', state: 'partial', accepted: 1, attempted: 3 }}
      />,
    );
    const failed = renderToStaticMarkup(
      <MailDeliveryStatus
        summary={{ purpose: 'gwg-invite', state: 'failed', accepted: 0, attempted: 1 }}
      />,
    );

    expect(partial).toContain('Mail zur neuen Anforderung: nur teilweise angenommen');
    expect(partial).toContain('(1 von 3)');
    expect(failed).toContain('GwG-Einladung: Versand fehlgeschlagen');
    expect(failed).not.toContain('emerald');
  });

  it('zeigt einen verworfenen Auftrag neutral und nennt den Grund im Hinweis', () => {
    const html = renderToStaticMarkup(
      <MailDeliveryStatus
        summary={{
          purpose: 'appointment-confirmed',
          state: 'skipped',
          accepted: 0,
          attempted: 0,
          skippedReason: 'Der Termin wurde abgesagt.',
        }}
      />,
    );

    expect(html).toContain('Terminbestätigung: nicht versendet – Vorgang nicht mehr aktuell');
    expect(html).toContain('data-mail-delivery="skipped"');
    expect(html).toContain('Grund: Der Termin wurde abgesagt.');
    expect(html).toContain('text-muted');
  });

  it('rendert ohne Versandaufträge nichts', () => {
    expect(renderToStaticMarkup(<MailDeliveryStatusList summaries={[]} />)).toBe('');
    expect(renderToStaticMarkup(<MailDeliveryStatusList summaries={undefined} />)).toBe('');
  });

  it('C4: bietet „Erneut senden“ nur für erneut sendbare Aufträge an', () => {
    const failed = renderToStaticMarkup(
      <MailDeliveryStatus
        summary={{
          purpose: 'invoice-sent',
          state: 'partial',
          accepted: 1,
          attempted: 2,
          resend: {
            purpose: 'invoice-sent',
            resourceType: 'invoice',
            resourceId: 'invoice-1',
            outboxIds: ['outbox-2'],
            uncertain: false,
          },
        }}
      />,
    );
    const withoutTarget = renderToStaticMarkup(
      <MailDeliveryStatus
        summary={{ purpose: 'invoice-sent', state: 'failed', accepted: 0, attempted: 1 }}
      />,
    );

    expect(failed).toContain('Rechnungsmail: nur teilweise angenommen');
    expect(failed).toContain('Erneut senden');
    expect(failed).toContain('data-mail-resend="failed"');
    expect(failed).not.toContain('möglicherweise bereits zugestellt');
    // Ohne erhaltenen Inhalt (z. B. nach Ablauf der Aufbewahrung) keine Schaltfläche.
    expect(withoutTarget).not.toContain('Erneut senden');
  });

  it('C4: weist bei unklarem Ausgang auf eine mögliche Doppelzustellung hin', () => {
    const html = renderToStaticMarkup(
      <MailDeliveryStatus
        summary={{
          purpose: 'appointment-confirmed',
          state: 'unknown',
          accepted: 0,
          attempted: 1,
          resend: {
            purpose: 'appointment-confirmed',
            resourceType: 'appointment_request',
            resourceId: 'request-1',
            outboxIds: ['outbox-1'],
            uncertain: true,
          },
        }}
      />,
    );

    expect(html).toContain('Terminbestätigung: Versandstatus unklar');
    expect(html).toContain('data-mail-resend="uncertain"');
    expect(MAIL_RESEND_UNCERTAIN_HINT).toContain('möglicherweise bereits zugestellt');
    expect(html).toContain('möglicherweise bereits zugestellt');
  });
});
