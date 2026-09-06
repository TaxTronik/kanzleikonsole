// Fachkatalog: MANDATE-STRUCTURE-001
// Fachkatalog: WORKFLOW-DEPENDENCY-001
// Fachkatalog: CLIENT-OFFBOARDING-001
// Fachkatalog: VDB-PREPARATION-001
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { structurePdf, handoverPdf, diagramLabel } from '../pdf';
describe('MANDATE-STRUCTURE-001 / CLIENT-OFFBOARDING-001 PDF artifacts', () => {
  it('marks diagram label truncation without splitting combining-name graphemes', () => {
    expect(diagramLabel('Short name')).toBe('Short name');
    expect(diagramLabel('Nguyễn An sehr langer Name')).toBe('Nguyễn An …');
    expect(diagramLabel('A\u0301'.repeat(12))).toBe('A\u0301'.repeat(10) + '…');
  });
  it('exports a graph and a separate complete table', async () => {
    const bytes = await structurePdf(
      {
        clientId: 'client',
        expectedRevision: 1,
        note: 'Manual snapshot',
        nodes: [
          {
            key: 'a',
            kind: 'CLIENT',
            label: 'Müller GmbH',
            linkedClientId: 'client',
            x: 20,
            y: 30,
          },
        ],
        edges: [],
      },
      1,
      'abc',
    );
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  });
  it('handles long handover notes across pages', async () => {
    const bytes = await handoverPdf({
      clientName: 'A GmbH',
      endDate: '2026-08-31',
      handoverNote: 'Offene Fristen sorgfältig übergeben. '.repeat(150),
      retentionNote: 'Einzelfall bleibt offen. '.repeat(100),
      sourceHash: 'hash',
      deadlines: [],
      notices: [],
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
  });
});
