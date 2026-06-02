// =============================================================================
// Report-Modell → DOCX (Word). Reiner Renderer, hängt nur am ReportModel.
// =============================================================================

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, UnderlineType,
} from 'docx';
import { DISCLAIMER, type ReportModel, type ReportSegment } from './report-model';

const hex = (c: string) => c.replace('#', '');

function meta(model: ReportModel): string {
  const parts = [
    model.clientName ? `Mandant: ${model.clientName}` : null,
    `Erstellt: ${model.createdAt.toLocaleDateString('de-DE')}`,
    `Markierungen: ${model.counts.gesamt} (davon ${model.counts.eigen} eigene)`,
    `Katalog ${model.katalogVersion} · Engine ${model.engineVersion}`,
    model.llmEnriched ? 'KI-vertieft' : null,
    `Hash ${model.textHash.slice(0, 16)}…`,
  ].filter(Boolean);
  return parts.join('  ·  ');
}

/** Annotierte Segmente → Absätze (markierte Stellen farbig unterstrichen). */
function sachverhaltParagraphs(segments: ReportSegment[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let runs: TextRun[] = [];
  for (const seg of segments) {
    const lines = seg.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        paragraphs.push(new Paragraph({ children: runs, spacing: { after: 120 } }));
        runs = [];
      }
      const t = lines[i]!;
      if (t.length === 0) continue;
      runs.push(
        new TextRun({
          text: t,
          underline: seg.color
            ? { type: seg.streitig ? UnderlineType.WAVE : UnderlineType.SINGLE, color: hex(seg.color) }
            : undefined,
        }),
      );
    }
  }
  paragraphs.push(new Paragraph({ children: runs, spacing: { after: 120 } }));
  return paragraphs;
}

function cell(lines: string[], opts: { header?: boolean; color?: string } = {}): TableCell {
  return new TableCell({
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    children: lines.map(
      (l) =>
        new Paragraph({
          children: [new TextRun({ text: l, bold: opts.header, size: 18, color: opts.color ? hex(opts.color) : undefined })],
        }),
    ),
  });
}

function markingsTable(model: ReportModel): Table {
  const header = new TableRow({
    tableHeader: true,
    children: ['Begriff', 'Herkunft · Status', 'Normanker', 'Governance · Risiko', 'Notiz · Kontrolle'].map((h) =>
      cell([h], { header: true }),
    ),
  });

  const rows = model.markings.map((m) => {
    const begriff = [m.begriff + (m.streitig ? '  ⚠ streitig' : '')];
    if (m.engineStatusLabel) begriff.push(m.engineStatusLabel);
    const herkunft = [m.herkunftLabel, m.statusLabel];
    const norm = m.normAnker.length ? m.normAnker : ['—'];
    const gov = [m.governanceLabel ?? '—'];
    const risiko = [m.schadenLabel, m.wahrscheinlichkeitLabel].filter(Boolean) as string[];
    const govRisiko = risiko.length ? [...gov, 'Risiko: ' + risiko.join(' / ')] : gov;
    const notiz = [m.notiz, m.kontrolle ? 'Maßnahme: ' + m.kontrolle : null].filter(Boolean) as string[];
    return new TableRow({
      children: [
        cell(begriff, { color: m.herkunftColor }),
        cell(herkunft),
        cell(norm),
        cell(govRisiko),
        cell(notiz.length ? notiz : ['—']),
      ],
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [2400, 1600, 1800, 1800, 2000],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC' },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC' },
      left: { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC' },
      right: { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC' },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC' },
    },
    rows: [header, ...rows],
  });
}

export async function renderDocx(model: ReportModel): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: model.title, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({ text: meta(model), size: 18, color: '666666' })], spacing: { after: 200 } }),
    new Paragraph({
      children: [new TextRun({ text: DISCLAIMER, italics: true, size: 18, color: '8A6D00' })],
      spacing: { after: 240 },
      alignment: AlignmentType.JUSTIFIED,
    }),
    new Paragraph({ text: 'Sachverhalt', heading: HeadingLevel.HEADING_2 }),
    ...sachverhaltParagraphs(model.segments),
    new Paragraph({ text: 'Markierungen', heading: HeadingLevel.HEADING_2, spacing: { before: 240 } }),
  ];
  if (model.markings.length > 0) {
    children.push(markingsTable(model));
  } else {
    children.push(new Paragraph({ children: [new TextRun({ text: 'Keine Markierungen.', italics: true, color: '666666' })] }));
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
