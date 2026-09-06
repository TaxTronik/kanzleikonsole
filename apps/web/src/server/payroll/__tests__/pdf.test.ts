// Fachkatalog: PAYROLL-INTAKE-001, DOC-UPLOAD-JOURNAL-001
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { extractText } from 'unpdf';
import { payrollPdf, type PayrollSnapshot } from '../pdf';

const snapshot: PayrollSnapshot = {
  schema: {
    employer: [
      {
        key: 'employment',
        label: 'Historische Beschäftigungsfrage',
        type: 'textarea',
        required: true,
      },
    ],
    employee: [
      { key: 'person', label: 'Historische Arbeitnehmerfrage', type: 'text', required: true },
    ],
  },
  employer: { employment: 'Vorliegende Beschäftigungsvereinbarung' },
  employee: { person: 'Synthetische Testperson' },
  status: 'REVIEWED',
  employerConfirmedAt: '2026-08-01T10:00:00Z',
  employeeSubmittedAt: '2026-08-02T10:00:00Z',
  advisorNumber: '123',
  clientNumber: '456',
  personnelNumber: '789',
  externalTasks: [
    {
      kind: 'SOFORTMELDUNG',
      status: 'EVIDENCE_RECORDED',
      evidence: 'Externes Testprotokoll, keine Übermittlung durch die Anwendung.',
      recordedAt: '2026-08-03T10:00:00Z',
    },
  ],
};
describe('PAYROLL-INTAKE-001 reproducible private review PDF', () => {
  it('reproduces exactly the same bytes for resumable storage of the same revision', async () => {
    const input = {
      label: 'Testvorgang',
      revision: 3,
      createdAt: new Date('2026-08-04T10:00:00Z'),
      snapshot,
    };
    const first = await payrollPdf(input),
      second = await payrollPdf(input);
    expect(second.equals(first)).toBe(true);
    const pdf = await PDFDocument.load(first);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe('Personalfragebogen');
  });
  it('paginates long historical answers instead of omitting the final sections', async () => {
    const bytes = await payrollPdf({
      label: 'Langer Testvorgang',
      revision: 4,
      createdAt: new Date('2026-08-04T10:00:00Z'),
      snapshot: {
        ...snapshot,
        employer: { employment: 'Ausführlicher historischer Sachverhalt. '.repeat(350) },
      },
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
  });
  it('preserves international employee names and the final external evidence in the actual PDF', async () => {
    const person = 'İpek Şahin · Łukasz Żółć · Nguyễn An · 李明';
    const bytes = await payrollPdf({
      label: 'Internationaler Prüfstand',
      revision: 5,
      createdAt: new Date('2026-08-04T10:00:00Z'),
      snapshot: { ...snapshot, employee: { person } },
    });
    const extracted = await extractText(new Uint8Array(bytes), { mergePages: true });
    for (const name of person.split(' · ')) expect(extracted.text).toContain(name);
    expect(extracted.text).toContain('Externes Testprotokoll');
  });
});
