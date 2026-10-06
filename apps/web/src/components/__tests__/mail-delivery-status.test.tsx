// F-08: Zustellstatus einer Mandanten-Mail am Vorgang.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MailDeliveryStatus, MailDeliveryStatusList } from '../mail-delivery-status';

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

  it('rendert ohne Versandaufträge nichts', () => {
    expect(renderToStaticMarkup(<MailDeliveryStatusList summaries={[]} />)).toBe('');
    expect(renderToStaticMarkup(<MailDeliveryStatusList summaries={undefined} />)).toBe('');
  });
});
