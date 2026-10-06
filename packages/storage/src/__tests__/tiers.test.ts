// Fachkatalog: GWG-RETENTION-DESTRUCTION-001
//
// R-14: eine Schutzstufen-Regel (ENV-frei) für Storage, Explorer und
// Detailseite. GwG-Nachweise sind keine GoBD-Belege.
import { describe, expect, it } from 'vitest';

import {
  classificationToTier,
  documentTier,
  isGobdClassification,
  isGwgClassification,
} from '../tiers';
import * as storage from '../index';

describe('Schutzstufen', () => {
  it('ordnet die Kern-Klassifikationen fest zu', () => {
    expect(classificationToTier('GOBD_INVOICE')).toBe('GOBD');
    expect(classificationToTier('GOBD_CONTRACT')).toBe('GOBD');
    expect(classificationToTier('GOBD_TAX')).toBe('GOBD');
    expect(classificationToTier('GWG_EVIDENCE')).toBe('GWG');
    expect(classificationToTier('GENERAL')).toBe('NONE');
    expect(classificationToTier('STAFF_PRIVATE')).toBe('NONE');
  });

  it('behandelt GwG-Nachweise nie als GoBD', () => {
    expect(isGobdClassification('GWG_EVIDENCE')).toBe(false);
    expect(isGwgClassification('GWG_EVIDENCE')).toBe(true);
    expect(documentTier('GWG_EVIDENCE', null)).toBe('GWG');
  });

  it('nimmt die Stufe des Dokumenttyps vor der Klassifikation', () => {
    expect(documentTier('GENERAL', 'GOBD')).toBe('GOBD');
    expect(documentTier('GOBD_TAX', undefined)).toBe('GOBD');
    expect(documentTier('GENERAL', null)).toBe('NONE');
  });

  it('exportiert dieselben Funktionen über den Paket-Einstieg', () => {
    expect(storage.classificationToTier).toBe(classificationToTier);
    expect(storage.documentTier).toBe(documentTier);
  });
});
