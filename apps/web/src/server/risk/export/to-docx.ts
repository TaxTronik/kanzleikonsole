// =============================================================================
// Report-Modell → DOCX (Word). Reiner Renderer, hängt nur am ReportModel.
// =============================================================================

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle, UnderlineType,
} from 'docx';
import { type ReportModel, type ReportToken } from './report-types';
import { fmtDateShort } from '@/lib/fmt';

const hex = (c: string) => c.replace('#', '');

function meta(model: ReportModel): string {
  return [
    model.clientName ? `Mandant: ${model.clientName}` : null,
    `Erstellt: ${fmtDateShort(model.createdAt)}`,
    `Markierungen: ${model.counts.gesamt} (davon ${model.counts.eigen} eigene)`,
    `Katalog ${model.katalogVersion} · Engine ${model.engineVersion}`,
    model.llmEnriched ? 'KI-vertieft' : null,
    `SHA-256: ${model.textHash}`,
  ]
    .filter(Boolean)
    .join('  ·  ');
}

/** Token-Strom → Absätze: markierte Stellen farbig unterstrichen, Marker „[n]". */
function sachverhaltParagraphs(tokens: ReportToken[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let runs: TextRun[] = [];
  const flush = () => { paragraphs.push(new Paragraph({ children: runs, spacing: { after: 120 } })); runs = []; };

  for (const tok of tokens) {
    if (tok.kind === 'marker') {
      runs.push(new TextRun({ text: `[${tok.nr}]`, superScript: true, bold: true, color: hex(tok.color) }));
      continue;
    }
    const lines = tok.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) flush();
      const t = lines[i]!;
      if (t.length === 0) continue;
      runs.push(
        new TextRun({
          text: t,
          underline: tok.color
            ? { type: tok.streitig ? UnderlineType.WAVE : UnderlineType.SINGLE, color: hex(tok.color) }
            : undefined,
        }),
      );
    }
  }
  flush();
  return paragraphs;
}

function cell(lines: string[], opts: { header?: boolean; color?: string } = {}): TableCell {
  return new TableCell({
    margins: { top: 50, bottom: 50, left: 80, right: 80 },
    children: lines.map(
      (l) =>
        new Paragraph({
          children: [new TextRun({ text: l, bold: opts.header, size: 17, color: opts.color ? hex(opts.color) : undefined })],
        }),
    ),
  });
}

function markingsTable(model: ReportModel): Table {
  const headers = ['Nr.', 'Fundstelle (markierter Text)', 'Begriff · Norm', 'Herkunft · Status', 'Governance · Risiko', 'Notiz · Maßnahme'];
  const header = new TableRow({ tableHeader: true, children: headers.map((h) => cell([h], { header: true })) });

  const rows = model.markings.map((m) => {
    const begriffLines = [m.begriff + (m.streitig ? '  ⚠ streitig' : '')];
    if (m.engineStatusLabel) begriffLines.push(m.engineStatusLabel);
    const normJoined = m.normAnker.join(', ');
    if (normJoined && normJoined !== m.begriff) begriffLines.push('Norm: ' + normJoined);

    const risiko = [m.schadenLabel, m.wahrscheinlichkeitLabel].filter(Boolean).join(' / ');
    const govRisiko = [m.governanceLabel ?? '—'];
    if (risiko) govRisiko.push('Risiko: ' + risiko);

    const notiz = [m.notiz, m.kontrolle ? 'Maßnahme: ' + m.kontrolle : null].filter(Boolean) as string[];

    return new TableRow({
      children: [
        cell([String(m.nr)], { color: m.herkunftColor }),
        cell([m.fundstelle || '—']),
        cell(begriffLines),
        cell([m.herkunftLabel, m.statusLabel]),
        cell(govRisiko),
        cell(notiz.length ? notiz : ['—']),
      ],
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [520, 2700, 1900, 1300, 1500, 1100],
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
    new Paragraph({ children: [new TextRun({ text: meta(model), size: 18, color: '666666' })], spacing: { after: 240 } }),
    new Paragraph({ text: 'Sachverhalt', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({
      children: [new TextRun({ text: 'Markierte Stellen sind unterstrichen und mit [Nr.] nummeriert — dieselbe Nr. findet sich in der Tabelle „Markierungen".', size: 16, color: '888888', italics: true })],
      spacing: { after: 120 },
    }),
    ...sachverhaltParagraphs(model.tokens),
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
