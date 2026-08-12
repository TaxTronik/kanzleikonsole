import { describe, it, expect } from 'vitest';
import { buildSetupItems, isSellerSetupComplete, type SetupState } from '../checklist';

// Wahrheitstabelle der Inbetriebnahme-Checkliste: jeder Punkt hängt an genau
// einem Zustands-Bit; Reihenfolge ist die empfohlene Einrichtungs-Reihenfolge
// (Anwenderdoku „Erste Schritte" verweist darauf).
const ALL_DONE: SetupState = {
  brandingComplete: true,
  regionSet: true,
  sellerComplete: true,
  smtpConfigured: true,
  modulesConfigured: true,
  privacyComplete: true,
  activeClientCount: 1,
  contactCount: 1,
};

const NONE_DONE: SetupState = {
  brandingComplete: false,
  regionSet: false,
  sellerComplete: false,
  smtpConfigured: false,
  modulesConfigured: false,
  privacyComplete: false,
  activeClientCount: 0,
  contactCount: 0,
};

describe('buildSetupItems', () => {
  it('frische Installation → alle 8 Punkte offen, in Einrichtungs-Reihenfolge', () => {
    const items = buildSetupItems(NONE_DONE);
    expect(items.map((i) => i.key)).toEqual([
      'branding',
      'region',
      'seller',
      'smtp',
      'modules',
      'privacy',
      'client',
      'contacts',
    ]);
    expect(items.every((i) => !i.done)).toBe(true);
    // Jeder offene Punkt führt irgendwohin und erklärt sich.
    expect(items.every((i) => i.href.startsWith('/staff/'))).toBe(true);
    expect(items.every((i) => (i.hint ?? '').length > 0)).toBe(true);
  });

  it('vollständig konfiguriert → alle Punkte erledigt', () => {
    expect(buildSetupItems(ALL_DONE).every((i) => i.done)).toBe(true);
  });

  it('jedes Zustands-Bit steuert genau seinen Punkt', () => {
    const cases: Array<[Partial<SetupState>, string]> = [
      [{ brandingComplete: false }, 'branding'],
      [{ regionSet: false }, 'region'],
      [{ sellerComplete: false }, 'seller'],
      [{ smtpConfigured: false }, 'smtp'],
      [{ modulesConfigured: false }, 'modules'],
      [{ privacyComplete: false }, 'privacy'],
      [{ activeClientCount: 0 }, 'client'],
      [{ contactCount: 0 }, 'contacts'],
    ];
    for (const [override, expectedOpen] of cases) {
      const items = buildSetupItems({ ...ALL_DONE, ...override });
      const open = items.filter((i) => !i.done).map((i) => i.key);
      expect(open, JSON.stringify(override)).toEqual([expectedOpen]);
    }
  });

  it('akzeptiert für E-Rechnungen USt-ID oder Steuernummer als Alternative', () => {
    const seller = {
      name: 'Kanzlei Beispiel',
      street: 'Musterstraße 1',
      postalCode: '10115',
      city: 'Berlin',
      email: 'kanzlei@example.test',
      phone: '+49 30 123456',
      vatId: 'DE123456789',
      taxNumber: null,
    };
    expect(isSellerSetupComplete(seller)).toBe(true);
    expect(isSellerSetupComplete({ ...seller, vatId: null, taxNumber: '12/345/67890' })).toBe(true);
    expect(isSellerSetupComplete({ ...seller, vatId: null, taxNumber: null })).toBe(false);
  });
});
