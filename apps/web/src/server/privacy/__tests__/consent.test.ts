import { describe, expect, it } from 'vitest';
import {
  countGranted,
  defaultConsentOptionsCatalog,
  emptyConsent,
  hasConsentRevocation,
  normalizeConsentOptionsCatalog,
  parseConsent,
} from '../consent';

const CUSTOM_ID = 'c8ecfcf4-aa72-47b5-a67e-d42fdc736dcc';

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

  it('erkennt den Entzug einer eigenen Option anhand der stabilen ID', () => {
    const previous = emptyConsent();
    previous.optionSelections = [
      {
        optionId: CUSTOM_ID,
        labelSnapshot: 'Digitale Beleganalyse',
        section: 'OTHER',
        serviceProviderSnapshot: null,
      },
    ];
    const renamed = emptyConsent();
    renamed.optionSelections = [
      {
        optionId: CUSTOM_ID,
        labelSnapshot: 'Digitale Analyse (neuer Name)',
        section: 'OTHER',
        serviceProviderSnapshot: null,
      },
    ];
    expect(hasConsentRevocation(previous, renamed)).toBe(false);
    expect(hasConsentRevocation(previous, emptyConsent())).toBe(true);
  });
});

describe('ConsentSelections V1/V2', () => {
  it('liest alte JSON-Snapshots ohne Optionsfeld unverändert weiter', () => {
    const legacy = parseConsent({ communication: { fax: true } });
    expect(legacy.communication.fax).toBe(true);
    expect(legacy.optionSelections).toEqual([]);
    expect(countGranted(legacy)).toBe(1);
  });

  it('zählt eigene Optionen, aber Built-in-Snapshots nicht doppelt', () => {
    const consent = emptyConsent();
    consent.communication.portal = true;
    consent.optionSelections = [
      {
        optionId: 'communication.portal',
        labelSnapshot: 'Mandantenportal',
        section: 'COMMUNICATION',
        serviceProviderSnapshot: null,
      },
      {
        optionId: CUSTOM_ID,
        labelSnapshot: 'Digitale Beleganalyse',
        section: 'OTHER',
        serviceProviderSnapshot: null,
      },
    ];
    expect(countGranted(consent)).toBe(2);
  });

  it('liest ältere Dienstleister-Snapshots ohne AVV-Felder weiter', () => {
    const parsed = parseConsent({
      optionSelections: [
        {
          optionId: CUSTOM_ID,
          labelSnapshot: 'Digitale Beleganalyse',
          section: 'OTHER',
          serviceProviderSnapshot: {
            id: '8d872603-4004-4d57-9a36-b789279bf288',
            name: 'Historischer Anbieter',
            category: 'IT / Cloud',
          },
        },
      ],
    });

    expect(parsed.optionSelections[0]?.serviceProviderSnapshot).toMatchObject({
      hasDataAccess: null,
      contractFromDate: null,
      contractToDate: null,
    });
  });
});

describe('Einwilligungsoptions-Katalog', () => {
  it('behält deaktivierte Built-ins, erzwingt aber ihre kanonische Semantik', () => {
    const input = defaultConsentOptionsCatalog();
    const fax = input.options.find((option) => option.id === 'communication.fax');
    if (!fax) throw new Error('Fax-Builtin fehlt');
    fax.active = false;
    fax.label = 'Manipuliertes Label';

    const normalized = normalizeConsentOptionsCatalog(input);
    expect(normalized.options.find((option) => option.id === 'communication.fax')).toMatchObject({
      active: false,
      label: 'Fax',
      builtin: true,
      section: 'COMMUNICATION',
    });
  });

  it('weist doppelte IDs und eigene Optionen ohne UUID zurück', () => {
    const defaults = defaultConsentOptionsCatalog();
    const first = defaults.options[0];
    if (!first) throw new Error('Built-in-Katalog ist leer');
    expect(() =>
      normalizeConsentOptionsCatalog({
        version: 1,
        options: [...defaults.options, { ...first }],
      }),
    ).toThrow(/Doppelte/);
    expect(() =>
      normalizeConsentOptionsCatalog({
        version: 1,
        options: [
          ...defaults.options,
          {
            id: 'custom-ohne-uuid',
            builtin: false,
            section: 'OTHER',
            label: 'Eigene Option',
            description: null,
            active: true,
            sortOrder: 1000,
            serviceProviderId: null,
          },
        ],
      }),
    ).toThrow(/UUID/);
  });
});
