import PDFDocument from 'pdfkit';
import { installUnicodePdfFonts } from '@/server/documents/pdf-fonts';
import { DATEV_GATE_MESSAGE, type PayrollField } from './definition';

export type PayrollSnapshot = {
  schema: { employer: PayrollField[]; employee: PayrollField[] };
  employer: Record<string, string>;
  employee: Record<string, string>;
  status: string;
  employerConfirmedAt: string | null;
  employeeSubmittedAt: string | null;
  advisorNumber: string | null;
  clientNumber: string | null;
  personnelNumber: string | null;
  attachments?: Array<{ id: string; sha256: string; versionId: string }>;
  externalTasks?: Array<{
    kind: string;
    status: string;
    evidence: string | null;
    recordedAt: string | null;
  }>;
};
export async function payrollPdf(input: {
  label: string;
  revision: number;
  createdAt: Date;
  snapshot: PayrollSnapshot;
}): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: { Title: 'Personalfragebogen', CreationDate: input.createdAt, ModDate: input.createdAt },
  });
  installUnicodePdfFonts(doc);
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (b: Buffer) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.fontSize(20).text('Personalfragebogen – Kanzleiprüfung');
  doc
    .moveDown()
    .fontSize(10)
    .text(input.label + ' · Revision ' + input.revision);
  doc.text('Vertraulicher Lohnvorgang. Kein Nachweis einer DATEV-Übertragung.');
  doc.moveDown().fontSize(9).text(DATEV_GATE_MESSAGE);
  doc
    .moveDown()
    .text(
      'Berater / Mandant / Personalnummer: ' +
        [input.snapshot.advisorNumber, input.snapshot.clientNumber, input.snapshot.personnelNumber]
          .map((v) => v ?? 'nicht bestätigt')
          .join(' / '),
    );
  for (const side of ['employer', 'employee'] as const) {
    doc
      .moveDown()
      .fontSize(15)
      .text(side === 'employer' ? 'Arbeitgeberangaben' : 'Arbeitnehmerangaben');
    doc.fontSize(10);
    for (const field of input.snapshot.schema[side]) {
      doc.moveDown(0.5).font('Helvetica-Bold').text(field.label);
      doc.font('Helvetica').text(input.snapshot[side][field.key] || '—');
    }
  }
  doc
    .moveDown()
    .fontSize(9)
    .text('Arbeitgeberbestätigung: ' + (input.snapshot.employerConfirmedAt ?? 'fehlt'));
  doc.text('Arbeitnehmerabgabe: ' + (input.snapshot.employeeSubmittedAt ?? 'fehlt'));
  for (const task of input.snapshot.externalTasks ?? []) {
    doc
      .moveDown()
      .font('Helvetica-Bold')
      .text('Externe Aufgabe: ' + task.kind + ' · ' + task.status);
    doc.font('Helvetica').text(task.evidence ?? 'Noch kein Nachweis erfasst.');
    if (task.recordedAt) doc.text('Dokumentiert am: ' + task.recordedAt);
  }
  doc.text(
    'Plausibilitätsprüfungen beweisen keine Nummernvergabe, Bankkontoinhaberschaft oder lohnsteuerliche Einordnung. Sofortmeldung und weitere Meldungen werden extern geprüft und durchgeführt.',
  );
  doc.end();
  return result;
}
