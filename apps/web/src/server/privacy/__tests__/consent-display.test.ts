import { describe, expect, it } from 'vitest';
import type { ResolvedConsentOption } from '../consent';
import { consentDisplayRevision, visibleConsentOptions } from '../consent-display';

const PROVIDER_ID = '8d872603-4004-4d57-9a36-b789279bf288';

function option(overrides: Partial<ResolvedConsentOption> = {}): ResolvedConsentOption {
  return {
    id: 'c8ecfcf4-aa72-47b5-a67e-d42fdc736dcc',
    builtin: false,
    section: 'OTHER',
    label: 'Digitale Beleganalyse',
    description: 'Verarbeitung eingereichter Belege',
    active: true,
    required: false,
    recommended: true,
    sortOrder: 1000,
    serviceProviderId: PROVIDER_ID,
    serviceProvider: {
      id: PROVIDER_ID,
      name: 'AVV Cloud GmbH',
      category: 'IT / Cloud',
      hasDataAccess: true,
      contractFromDate: '2025-01-01',
      contractToDate: null,
    },
    providerMissing: false,
    ...overrides,
  };
}

const notice = { version: 7, body: 'Exakt angezeigter Datenschutzhinweis\nmit zweiter Zeile.' };

describe('consentDisplayRevision', () => {
  it('ist deterministisch, hex-kodiert und bindet die Anzeige-Reihenfolge', () => {
    const first = option();
    const second = option({
      id: '0bc8ce8b-e192-49fa-a6bb-5888a1c42f9f',
      label: 'Zweite Option',
      sortOrder: 1010,
      serviceProviderId: null,
      serviceProvider: null,
    });

    const revision = consentDisplayRevision(notice, [first, second]);

    expect(revision).toMatch(/^[a-f0-9]{64}$/);
    expect(consentDisplayRevision({ ...notice }, [{ ...first }, { ...second }])).toBe(revision);
    expect(consentDisplayRevision(notice, [second, first])).not.toBe(revision);
  });

  it.each([
    ['Hinweistext', { notice: { ...notice, body: `${notice.body} Geändert.` }, option: option() }],
    ['Beschreibung', { notice, option: option({ description: 'Neue Beschreibung' }) }],
    [
      'Dienstleister-Snapshot',
      {
        notice,
        option: option({
          serviceProvider: { ...option().serviceProvider!, name: 'Neuer Anbietername' },
        }),
      },
    ],
    ['Pflicht-Kennzeichnung', { notice, option: option({ required: true }) }],
    ['Empfehlungs-Kennzeichnung', { notice, option: option({ recommended: false }) }],
  ])('erkennt eine geänderte %s als andere Revision', (_label, changed) => {
    const original = consentDisplayRevision(notice, [option()]);

    expect(consentDisplayRevision(changed.notice, [changed.option])).not.toBe(original);
  });

  it('liefert exakt den sichtbaren, vollständig aufgelösten Katalog', () => {
    const inactive = option({ id: 'inactive', active: false });
    const missingProvider = option({
      id: 'missing-provider',
      serviceProvider: null,
      providerMissing: true,
    });
    const visible = option();

    expect(visibleConsentOptions([inactive, missingProvider, visible])).toEqual([visible]);
  });
});
