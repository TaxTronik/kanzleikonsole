import PDFDocument from 'pdfkit';
import type { StructureInput } from './model';
import { installUnicodePdfFonts } from '@/server/documents/pdf-fonts';

function output(doc: PDFKit.PDFDocument) {
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
export function diagramLabel(label: string) {
  const parts = [
    ...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(label.replace(/\s+/g, ' ')),
  ].map((p) => p.segment);
  return parts.length > 10 ? parts.slice(0, 10).join('') + '…' : parts.join('');
}
export async function structurePdf(
  input: StructureInput,
  revision: number,
  hash: string,
  createdAt = new Date('2000-01-01T00:00:00Z'),
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 35,
    info: { CreationDate: createdAt, ModDate: createdAt },
  });
  const result = output(doc);
  installUnicodePdfFonts(doc);
  doc.fontSize(20).text('Mandanten- und Beteiligungsstruktur');
  doc.moveDown(0.3).fontSize(9).text(`Arbeitsstand ${revision} · SHA-256 ${hash}`);
  doc.text(
    'Manuelle Angaben. Keine automatische WB-Ermittlung, mittelbare Quote oder steuerliche Organschaft.',
  );
  const ox = 35,
    oy = 120,
    sx = 0.74,
    sy = 0.64;
  const nodes = new Map(input.nodes.map((n) => [n.key, n]));
  for (const e of input.edges) {
    const a = nodes.get(e.from),
      b = nodes.get(e.to);
    if (!a || !b) continue;
    doc
      .strokeColor('#94a3b8')
      .moveTo(ox + a.x * sx + 40, oy + a.y * sy + 16)
      .lineTo(ox + b.x * sx + 40, oy + b.y * sy + 16)
      .stroke();
    doc
      .fontSize(7)
      .fillColor('#334155')
      .text(
        e.percentage === null ? e.kind : `${e.percentage}% ${e.kind}`,
        ox + ((a.x + b.x) * sx) / 2,
        oy + ((a.y + b.y) * sy) / 2,
        { width: 100 },
      );
  }
  for (const [index, n] of input.nodes.entries()) {
    doc
      .roundedRect(ox + n.x * sx, oy + n.y * sy, 100, 38, 4)
      .fillAndStroke(n.kind === 'CLIENT' ? '#dbeafe' : '#f1f5f9', '#64748b');
    doc
      .fillColor('#0f172a')
      .fontSize(8)
      .text('#' + String(index + 1).padStart(2, '0'), ox + n.x * sx + 4, oy + n.y * sy + 4, {
        width: 92,
        height: 12,
      });
    doc.text(diagramLabel(n.label), ox + n.x * sx + 4, oy + n.y * sy + 18, {
      width: 92,
      height: 15,
    });
  }
  doc
    .addPage({ layout: 'portrait' })
    .fontSize(17)
    .text('Vollständige Tabellenansicht dieses Arbeitsstands');
  doc.moveDown().fontSize(10);
  for (const [index, n] of input.nodes.entries())
    doc
      .text(
        `#${String(index + 1).padStart(2, '0')} ${n.label} (${n.kind})${n.linkedClientId ? ` · Mandanten-ID ${n.linkedClientId}` : ''}`,
      )
      .moveDown(0.4);
  doc.moveDown().fontSize(14).text('Direkte Verbindungen').moveDown(0.4).fontSize(10);
  for (const e of input.edges)
    doc
      .text(
        `${nodes.get(e.from)?.label} -> ${nodes.get(e.to)?.label}: ${e.kind}, ${e.percentage === null ? 'keine Quote angegeben' : `${e.percentage} %`}${e.note ? ` – ${e.note}` : ''}`,
      )
      .moveDown(0.5);
  if (input.note) doc.moveDown().text(`Erläuterung: ${input.note}`);
  doc.end();
  return result;
}
export async function handoverPdf(data: {
  clientName: string;
  endDate: string;
  handoverNote: string;
  retentionNote: string;
  sourceHash: string;
  preparationHash?: string;
  generator?: string;
  createdAt?: Date;
  documents?: Array<{
    title: string;
    versionId: string;
    classification: string;
    sha256: string;
    approvedBy: string;
    approvedAt: string;
    sensitiveApproved: boolean;
  }>;
  deadlines: Array<{ kind: string; period: string; dueDate: string; status: string }>;
  notices: Array<{ kind: string; period: string; appealDeadline: string | null; status: string }>;
}): Promise<Buffer> {
  const createdAt = data.createdAt ?? new Date('2000-01-01T00:00:00Z');
  const doc = new PDFDocument({
    size: 'A4',
    margin: 45,
    info: { CreationDate: createdAt, ModDate: createdAt },
  });
  const result = output(doc);
  installUnicodePdfFonts(doc);
  doc.fontSize(20).text('Mandatsübergabe – Prüfprotokoll');
  doc.moveDown().fontSize(11).text(`${data.clientName}\nMandatsende: ${data.endDate}`);
  doc.moveDown().text('Übergabe / offene Vorgänge').text(data.handoverNote);
  doc.moveDown().text('Aufbewahrungsprüfung / offene Ausnahmen').text(data.retentionNote);
  doc
    .moveDown()
    .text(
      'Keine automatische Fristbeendigung, Löschung oder Löschfreigabe. Die tatsächliche Herausgabe erfolgt außerhalb dieses Downloads.',
    );
  doc.moveDown().fontSize(9).text(`Prüfstand SHA-256: ${data.sourceHash}`);
  if (data.preparationHash) doc.text(`Freigabe SHA-256: ${data.preparationHash}`);
  if (data.generator) doc.text(`Generator: ${data.generator}`);
  if (data.documents) {
    doc.moveDown().fontSize(13).text('Ausdrücklich freigegebene Fassungen').fontSize(9);
    if (!data.documents.length) doc.text('Keine Dokumentfassungen ausgewählt.');
    for (const d of data.documents)
      doc
        .text(
          `${d.title} (${d.classification})\nFassung: ${d.versionId}\nSHA-256: ${d.sha256}\nFreigabe: ${d.approvedBy} · ${d.approvedAt}${d.sensitiveApproved ? ' · Zusätzliche sensible Freigabe bestätigt' : ''}`,
        )
        .moveDown(0.5);
  }
  doc.moveDown().fontSize(13).text('Offene Steuertermine').fontSize(10);
  for (const d of data.deadlines)
    doc.text(`${d.kind} ${d.period}: ${d.dueDate.slice(0, 10)} (${d.status})`);
  doc.moveDown().fontSize(13).text('Bescheide / Einspruchskontrolle').fontSize(10);
  for (const n of data.notices)
    doc.text(
      `${n.kind} ${n.period}: ${n.appealDeadline?.slice(0, 10) ?? 'Frist noch zu prüfen'} (${n.status})`,
    );
  doc.end();
  return result;
}
