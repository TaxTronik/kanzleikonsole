import { describe, expect, it } from 'vitest';
import {
  consentForNewDeclaration,
  countGranted,
  countRevocableGranted,
  defaultConsentOptionsCatalog,
  emptyConsent,
  hasConsentRevocation,
  missingRequiredConsentOptions,
  normalizeConsentOptionsCatalog,
  parseConsent,
  PortalConsentSelectionsSchema,
  revokeVoluntaryConsent,
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
        descriptionSnapshot: null,
        section: 'OTHER',
        requiredSnapshot: false,
        recommendedSnapshot: false,
        serviceProviderSnapshot: null,
      },
    ];
    const renamed = emptyConsent();
    renamed.optionSelections = [
      {
        optionId: CUSTOM_ID,
        labelSnapshot: 'Digitale Analyse (neuer Name)',
        descriptionSnapshot: null,
        section: 'OTHER',
        requiredSnapshot: false,
        recommendedSnapshot: false,
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
        descriptionSnapshot: null,
        section: 'COMMUNICATION',
        requiredSnapshot: false,
        recommendedSnapshot: false,
        serviceProviderSnapshot: null,
      },
      {
        optionId: CUSTOM_ID,
        labelSnapshot: 'Digitale Beleganalyse',
        descriptionSnapshot: null,
        section: 'OTHER',
        requiredSnapshot: false,
        recommendedSnapshot: false,
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
    expect(parsed.optionSelections[0]).toMatchObject({
      descriptionSnapshot: null,
      requiredSnapshot: false,
      recommendedSnapshot: false,
    });
  });
});

describe('revokeVoluntaryConsent', () => {
  it('entfernt freiwillige Auswahlen und erhaelt Pflichtbestaetigungen exakt', () => {
    const consent = emptyConsent();
    consent.communication.emailTls = true;
    consent.marketing.emailNewsletter = true;
    consent.thirdParties = [
      { recipient: 'Bank', purpose: 'Kredit', data: 'BWA', channel: 'Portal' },
    ];
    consent.specialists = [
      {
        entity: 'Gutachter GmbH',
        service: 'Bewertung',
        accessType: 'Datenraum',
        requirements: 'Verschwiegenheit',
      },
    ];
    const required = {
      optionId: CUSTOM_ID,
      labelSnapshot: 'Notwendige Bestaetigung',
      descriptionSnapshot: 'Bei Mandatsannahme erforderlich',
      section: 'OTHER' as const,
      requiredSnapshot: true,
      recommendedSnapshot: false,
      serviceProviderSnapshot: null,
    };
    consent.optionSelections = [
      required,
      {
        ...required,
        optionId: '7e1c134e-1d2a-44a5-b135-43cf35c0d6ee',
        labelSnapshot: 'Freiwillige Zusatzoption',
        requiredSnapshot: false,
      },
    ];

    const revoked = revokeVoluntaryConsent(consent);

    expect(revoked).toEqual({
      ...emptyConsent(),
      optionSelections: [required],
    });
    expect(revoked.optionSelections[0]).toBe(required);
    expect(countGranted(consent)).toBe(6);
    expect(countRevocableGranted(consent)).toBe(5);
  });

  it('ist bei einem reinen Pflichtbestaetigungs-Snapshot ein fachlicher No-op', () => {
    const consent = emptyConsent();
    consent.optionSelections = [
      {
        optionId: CUSTOM_ID,
        labelSnapshot: 'Notwendige Bestaetigung',
        descriptionSnapshot: null,
        section: 'OTHER',
        requiredSnapshot: true,
        recommendedSnapshot: false,
        serviceProviderSnapshot: null,
      },
    ];

    expect(revokeVoluntaryConsent(consent)).toEqual(consent);
    expect(countRevocableGranted(consent)).toBe(0);
  });
});

describe('PortalConsentSelectionsSchema', () => {
  it('erlaubt ausschließlich Auswahlen aus dem Kanzlei-Katalog', () => {
    const consent = emptyConsent();
    consent.communication.portal = true;
    consent.optionSelections = [
      {
        optionId: CUSTOM_ID,
        labelSnapshot: 'Kanzlei-Option',
        descriptionSnapshot: null,
        section: 'OTHER',
        requiredSnapshot: false,
        recommendedSnapshot: false,
        serviceProviderSnapshot: null,
      },
    ];

    expect(PortalConsentSelectionsSchema.safeParse(consent).success).toBe(true);
  });

  it.each([
    [
      'Kommunikationsfreitext',
      (consent: ReturnType<typeof emptyConsent>) => {
        consent.communication.details = 'Private E-Mail-Adresse';
      },
    ],
    [
      'Marketingfreitext',
      (consent: ReturnType<typeof emptyConsent>) => {
        consent.marketing.details = 'Zusätzliche Adresse';
      },
    ],
    [
      'eigene Empfänger',
      (consent: ReturnType<typeof emptyConsent>) => {
        consent.thirdParties = [
          { recipient: 'Eigener Empfänger', purpose: '', data: '', channel: '' },
        ];
      },
    ],
    [
      'eigene Spezialdienstleister',
      (consent: ReturnType<typeof emptyConsent>) => {
        consent.specialists = [
          { entity: 'Eigener Dienstleister', service: '', accessType: '', requirements: '' },
        ];
      },
    ],
  ])('weist %s im Mandantenportal zurück', (_label, mutate) => {
    const consent = emptyConsent();
    mutate(consent);

    expect(PortalConsentSelectionsSchema.safeParse(consent).success).toBe(false);
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

  it('migriert einen V1-Katalog sicher auf V2 ohne neue Vorgaben', () => {
    const legacy = {
      version: 1 as const,
      options: defaultConsentOptionsCatalog().options.map(
        ({ required: _required, recommended: _recommended, ...option }) => option,
      ),
    };

    const normalized = normalizeConsentOptionsCatalog(legacy);

    expect(normalized.version).toBe(2);
    expect(normalized.options.every((option) => !option.required && !option.recommended)).toBe(
      true,
    );
  });

  it('lässt Empfehlungen bei neuen Erklärungen ungekreuzt und erkennt Pflichtoptionen', () => {
    const options = defaultConsentOptionsCatalog().options.map((option) => ({
      ...option,
      recommended: option.id === 'communication.emailTls',
      serviceProvider: null,
      providerMissing: false,
    }));
    options.push({
      id: CUSTOM_ID,
      builtin: false,
      section: 'OTHER',
      label: 'Notwendige Bestätigung',
      description: null,
      active: true,
      required: true,
      recommended: false,
      sortOrder: 1000,
      serviceProviderId: null,
      serviceProvider: null,
      providerMissing: false,
    });

    const initial = consentForNewDeclaration();

    expect(initial.communication.emailTls).toBe(false);
    expect(initial.communication.portal).toBe(false);
    expect(initial.optionSelections).toEqual([]);
    expect(missingRequiredConsentOptions(initial, options).map((option) => option.id)).toEqual([
      CUSTOM_ID,
    ]);
  });

  it('verbietet Pflicht-Einwilligungen für Kommunikation und Marketing', () => {
    const catalog = defaultConsentOptionsCatalog();
    const newsletter = catalog.options.find((option) => option.id === 'marketing.emailNewsletter');
    if (!newsletter) throw new Error('Newsletter-Builtin fehlt');
    newsletter.required = true;

    expect(() => normalizeConsentOptionsCatalog(catalog)).toThrow(/Bereich OTHER/);
  });

  it('verhindert Pflicht-Built-ins auch bei gefälschter Bereichsangabe', () => {
    const catalog = defaultConsentOptionsCatalog();
    const fax = catalog.options.find((option) => option.id === 'communication.fax');
    if (!fax) throw new Error('Fax-Builtin fehlt');
    fax.section = 'OTHER';
    fax.required = true;

    expect(() => normalizeConsentOptionsCatalog(catalog)).toThrow(/eigene.*Bereich OTHER/);
  });

  it('weist Vorgaben auf inaktiven Optionen zurück', () => {
    const catalog = defaultConsentOptionsCatalog();
    const fax = catalog.options.find((option) => option.id === 'communication.fax');
    if (!fax) throw new Error('Fax-Builtin fehlt');
    fax.active = false;
    fax.required = true;

    expect(() => normalizeConsentOptionsCatalog(catalog)).toThrow(/Inaktive/);
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
            required: false,
            recommended: false,
            sortOrder: 1000,
            serviceProviderId: null,
          },
        ],
      }),
    ).toThrow(/UUID/);
  });
});
