// Fachkatalog: DOC-UPLOAD-JOURNAL-001, RISK-AI-SUGGESTION-001
// Welle 15: Die Freigabe für Leser mit Begründung (Textübernahme der Subsumtion)
// ist exakt die Auslieferungsfreigabe von Download und Vorschau; unterschieden
// wird nur, ob die Prüfung noch läuft oder die Fassung abgewiesen wurde.
import { describe, expect, it } from 'vitest';
import { documentVersionReadiness, isDocumentVersionReady } from '../delivery-readiness';

const DONE = new Date('2026-10-01T08:00:00.000Z');

describe('documentVersionReadiness', () => {
  it.each([
    [{ scanStatus: 'CLEAN', scanCompletedAt: DONE }, 'ready'],
    [{ scanStatus: 'CLEAN', scanCompletedAt: null }, 'scan_pending'],
    [{ scanStatus: 'PENDING', scanCompletedAt: null }, 'scan_pending'],
    [{ scanStatus: 'INFECTED', scanCompletedAt: DONE }, 'scan_rejected'],
    [{ scanStatus: 'ERROR', scanCompletedAt: null }, 'scan_rejected'],
    [{ scanStatus: 'BLOCKED', scanCompletedAt: DONE }, 'scan_rejected'],
  ] as const)('%o → %s', (version, expected) => {
    expect(documentVersionReadiness(version)).toBe(expected);
    // „ready“ genau dann, wenn Download und Vorschau ausliefern würden.
    expect(documentVersionReadiness(version) === 'ready').toBe(isDocumentVersionReady(version));
  });
});
