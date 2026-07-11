import { describe, expect, it } from 'vitest';
import { emptyConsent, hasConsentRevocation } from '../consent';

describe('hasConsentRevocation', () => {
  it('erkennt true → false auch bei gleichzeitiger neuer Einwilligung', () => {
    const previous = emptyConsent();
    previous.communication.emailTls = true;
    const next = emptyConsent();
    next.communication.phone = true;
    expect(hasConsentRevocation(previous, next)).toBe(true);
  });

  it('erkennt entfernte konkret benannte Dritte', () => {
    const previous = emptyConsent();
    previous.thirdParties = [
      { recipient: 'Bank', purpose: 'Kredit', data: 'BWA', channel: 'Portal' },
    ];
    expect(hasConsentRevocation(previous, emptyConsent())).toBe(true);
  });

  it('wertet reine Erweiterung nicht als Widerruf', () => {
    const previous = emptyConsent();
    const next = emptyConsent();
    next.marketing.emailNewsletter = true;
    expect(hasConsentRevocation(previous, next)).toBe(false);
  });
});
