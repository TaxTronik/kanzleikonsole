// Fachkatalog: CLIENT-ASSISTANCE-001
// Fachkatalog: DOC-UPLOAD-JOURNAL-001
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { strFromU8, unzipSync } from 'fflate';
import {
  assistanceSnapshotHash,
  checkedAssistanceSnapshot,
  buildAssistanceSnapshot,
} from '../snapshot';
import { assistancePdf, assistanceDocx, type AssistanceReport } from '../report';
import { validateCaseAnswers } from '../definitions';

const item = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Verfahrensdokumentation',
  kind: 'PROCEDURE',
  revision: 1,
  status: 'SUBMITTED',
  answers: { organization: 'Historische Organisation' },
  schemaSnapshot: {
    title: 'Historische Vorlage',
    version: 1,
    fields: [{ key: 'organization', label: 'Historische Frage', type: 'textarea' }],
  },
  sourceDocumentVersionId: null,
  sourceHash: null,
  externalDocumentVersionId: null,
  externalDocumentHash: null,
  confirmedAt: new Date('2026-08-01Z'),
  reviewNote: null,
  reviewedByStaff: null,
};
const at = new Date('2026-08-01T12:00:00Z');
describe('CLIENT-ASSISTANCE-001 immutable source and human confirmation', () => {
  it('binds the complete schema, answers, source and review metadata independently of JSON key order', () => {
    const snapshot = buildAssistanceSnapshot(item, at);
    const hash = assistanceSnapshotHash(snapshot);
    expect(checkedAssistanceSnapshot(JSON.parse(JSON.stringify(snapshot)), hash)).toEqual(snapshot);
    expect(assistanceSnapshotHash(Object.fromEntries(Object.entries(snapshot).reverse()))).toBe(
      hash,
    );
    expect(() =>
      checkedAssistanceSnapshot({ ...snapshot, reviewNote: 'Invented approval' }, hash),
    ).toThrow();
    expect(() =>
      checkedAssistanceSnapshot({ ...snapshot, schema: { ...snapshot.schema, fields: [] } }, hash),
    ).toThrow();
  });
  it('requires actual facts and confirmation when submitting, while allowing incomplete drafts', () => {
    expect(validateCaseAnswers('EIGENBELEG', {}, false, false)).toEqual([]);
    expect(validateCaseAnswers('EIGENBELEG', {}, true, false).length).toBeGreaterThan(1);
    expect(
      validateCaseAnswers('BEWIRTUNG', { date: '2026-02-30', amount: '-2' }, false, false).length,
    ).toBe(2);
    expect(validateCaseAnswers('PROCEDURE', { unknown: 'value' }, false, false)).toContain(
      'Unbekanntes Eingabefeld.',
    );
  });
  it('retains the frozen field definitions when the live questionnaire changes', () => {
    expect(
      validateCaseAnswers('PROCEDURE', { legacy: 'answer' }, true, true, [
        { key: 'legacy', label: 'Alte Frage', required: true },
      ]),
    ).toEqual([]);
  });
});
describe('CLIENT-ASSISTANCE-001 / DOC-UPLOAD-JOURNAL-001 reproducible output bytes', () => {
  const report: AssistanceReport = {
    title: 'Historische Verfahrensdokumentation',
    kind: 'PROCEDURE',
    revision: 3,
    status: 'REVIEWED',
    createdAt: at.toISOString(),
    answers: { legacy: 'Ältere Beschreibung' },
    fields: [{ key: 'legacy', label: 'Historische Frage' }],
    snapshotHash: 'a'.repeat(64),
  };
  it('renders a fixed PDF identically for upload recovery', async () => {
    const first = await assistancePdf(report),
      second = await assistancePdf(report);
    expect(second.equals(first)).toBe(true);
    expect((await PDFDocument.load(first)).getPageCount()).toBe(1);
  });
  it('normalizes Word timestamps for byte-identical recovery and preserves historical fields', async () => {
    const first = await assistanceDocx(report),
      second = await assistanceDocx(report);
    expect(second.equals(first)).toBe(true);
    const zip = unzipSync(first);
    expect(strFromU8(zip['word/document.xml']!)).toContain('Historische Frage');
    expect(strFromU8(zip['word/document.xml']!)).toContain('Ältere Beschreibung');
    expect(strFromU8(zip['docProps/custom.xml']!)).toContain('TaxTronikSnapshotHash');
    expect(strFromU8(zip['docProps/core.xml']!)).toContain(at.toISOString());
  });
  it('paginates long answers without dropping the final section', async () => {
    const bytes = await assistancePdf({
      ...report,
      answers: { legacy: 'Gelebtes Verfahren mit offenen Punkten. '.repeat(300) },
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
  });
});
