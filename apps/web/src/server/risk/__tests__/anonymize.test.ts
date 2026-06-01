import { describe, it, expect } from 'vitest';
import { anonymize, deanonymize } from '../anonymize';

// Rein synthetische Daten — keine Echtdaten (siehe Memory-Vorgabe).
const client = {
  name: 'Mustermann Holding GmbH',
  datevNo: '548211',
  vatId: 'DE123456789',
  street: 'Beispielweg 5',
  postalCode: '80331',
  city: 'München',
};
const contacts = [{ fullName: 'Erika Beispiel', email: 'erika@example.test', phone: '+49 89 1234567' }];

const sachverhalt =
  'Die Mustermann Holding GmbH (USt-ID DE123456789, DATEV 548211) in München wird von ' +
  'Erika Beispiel (erika@example.test) geführt. Die T-GmbH zahlte 50.000 € an einen Investor. ' +
  'Zum 1.4.2026 wechselt die Geschäftsführung.';

describe('anonymize (§ 203)', () => {
  const r = anonymize(sachverhalt, { client, contacts });

  it('entfernt ALLE bekannten Mandanten-/Kontakt-Klartextdaten', () => {
    for (const secret of [
      'Mustermann Holding GmbH',
      'Erika Beispiel',
      'erika@example.test',
      'DE123456789',
      '548211',
      'München',
    ]) {
      expect(r.text).not.toContain(secret);
    }
  });

  it('setzt deterministische Platzhalter', () => {
    expect(r.text).toContain('[MANDANT]');
    expect(r.text).toContain('[PERSON_1]');
    expect(r.text).toContain('[USTID]');
    expect(r.text).toContain('[DATEV_NR]');
    expect(r.text).toContain('[ORT]');
  });

  it('greift heuristisch bei Bindestrich-Firma, Betrag und Datum', () => {
    expect(r.text).toMatch(/\[FIRMA_\d+\]/); // T-GmbH
    expect(r.text).toMatch(/\[BETRAG_\d+\]/); // 50.000 €
    expect(r.text).toMatch(/\[DATUM_\d+\]/); // 1.4.2026
    expect(r.heuristicHits.length).toBeGreaterThan(0);
  });

  it('mapping verlässt nie das Original und stellt es per deanonymize wieder her', () => {
    // Round-trip: aus dem anonymisierten Text wird wieder das Original.
    const restored = deanonymize(r.text, r.mapping);
    expect(restored).toContain('Mustermann Holding GmbH');
    expect(restored).toContain('Erika Beispiel');
    expect(restored).toContain('DE123456789');
    expect(restored).toContain('T-GmbH');
    expect(restored).toContain('50.000 €');
  });

  it('leerer/irrelevanter Text bleibt unverändert', () => {
    const empty = anonymize('Allgemeine Rechtsfrage zu § 8c KStG.', { client, contacts });
    expect(empty.text).toBe('Allgemeine Rechtsfrage zu § 8c KStG.');
    expect(empty.heuristicHits).toEqual([]);
  });
});
