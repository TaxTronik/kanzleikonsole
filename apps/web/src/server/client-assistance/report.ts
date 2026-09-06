import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import { CASE_DEFINITIONS, type CaseKind } from './definitions';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { ASSISTANCE_GENERATOR } from './snapshot';
import { installUnicodePdfFonts } from '@/server/documents/pdf-fonts';

export interface AssistanceReport {
  title: string;
  kind: CaseKind;
  revision: number;
  status: string;
  createdAt: string;
  answers: Record<string, string>;
  sourceHash?: string | null;
  fields?: Array<{ key: string; label: string }>;
  snapshotHash?: string;
  externalHash?: string | null;
  reviewNote?: string | null;
}
function lines(report: AssistanceReport) {
  const fields = report.fields ?? CASE_DEFINITIONS[report.kind].fields;
  return [
    [
      'Bearbeitungsstand',
      report.status + ' · Fassung ' + report.revision + ' · ' + report.createdAt,
    ],
    [
      'Hinweis',
      'Dokumentation der angegebenen Tatsachen. Keine automatische steuerliche Anerkennung oder GoBD-Konformitätsbestätigung.',
    ],
    [
      'Generator / Arbeitsgrundlage',
      ASSISTANCE_GENERATOR + ' · Snapshot SHA-256 ' + (report.snapshotHash ?? 'nicht archiviert'),
    ],
    ...(report.sourceHash ? [['Originalbeleg SHA-256', report.sourceHash]] : []),
    ...(report.externalHash
      ? [
          ['Externe Word-Fassung SHA-256', report.externalHash],
          [
            'Ausgabegrenze',
            'Dieses PDF ist das Prüfprotokoll der externen Word-Fassung. Es ist keine Konvertierung und enthält nicht den vollständigen Word-Inhalt. Die gebundene Word-Datei bleibt maßgebliche Dateifassung.',
          ],
        ]
      : fields.map((field) => [
          field.label,
          report.answers[field.key]?.trim() || 'OFFEN / NICHT ANGEGEBEN',
        ])),
    ...(report.reviewNote ? [['Prüfvermerk', report.reviewNote]] : []),
  ];
}
export async function assistancePdf(report: AssistanceReport): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: {
      Title: report.title,
      Author: 'TaxTronik',
      CreationDate: new Date(report.createdAt),
      ModDate: new Date(report.createdAt),
    },
  });
  installUnicodePdfFonts(doc);
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (b: Buffer) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.fontSize(20).text(report.title).moveDown();
  for (const [label, value] of lines(report)) {
    if (doc.y > 710) doc.addPage();
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .text(label ?? '');
    doc
      .font('Helvetica')
      .fontSize(10)
      .text(value ?? '', { lineGap: 3 })
      .moveDown();
  }
  doc.end();
  return result;
}
export async function assistanceDocx(report: AssistanceReport): Promise<Buffer> {
  const bytes = await Packer.toBuffer(
    new Document({
      title: report.title,
      creator: 'TaxTronik',
      revision: report.revision,
      customProperties: [
        { name: 'TaxTronikGenerator', value: ASSISTANCE_GENERATOR },
        { name: 'TaxTronikSnapshotHash', value: report.snapshotHash ?? '' },
      ],
      sections: [
        {
          children: [
            new Paragraph({ text: report.title, heading: HeadingLevel.TITLE }),
            ...lines(report).flatMap(([label, value]) => [
              new Paragraph({ text: label, heading: HeadingLevel.HEADING_2 }),
              ...String(value ?? '')
                .split('\n')
                .map((text) => new Paragraph({ children: [new TextRun(text)] })),
            ]),
          ],
        },
      ],
    }),
  );
  // docx stamps its ZIP and core metadata with wall time. Normalize trusted generated entries,
  // so a lost Store response can be resumed with exactly the prepared bytes.
  const entries = unzipSync(bytes);
  const core = entries['docProps/core.xml'];
  if (core)
    entries['docProps/core.xml'] = strToU8(
      strFromU8(core).replace(
        /(<dcterms:(created|modified)[^>]*>)[^<]*(<\/dcterms:\2>)/g,
        `$1${report.createdAt}$3`,
      ),
    );
  return Buffer.from(zipSync(entries, { level: 6, mtime: new Date('2000-01-01T00:00:00Z') }));
}
