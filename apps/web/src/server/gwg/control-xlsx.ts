import { strToU8, zipSync } from 'fflate';
import { CONTROL_ROW_LIMIT, CONTROL_STATE_LABELS, type ControlRow } from './control-list-model';

const xml = (value: string) =>
  // XML 1.0 character ranges: reject controls and isolated surrogate values.
  Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return (
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        code >= 0x10000
      );
    })
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
function columnName(index: number): string {
  let result = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  return result;
}
function sheet(rows: string[][]): string {
  if (rows.some((cells) => cells.some((value) => value.length > 32_767)))
    throw new Error('Ein Feld überschreitet die maximale Excel-Zelllänge.');
  const last = `${columnName(rows[0]!.length - 1)}${rows.length}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${rows[0]!.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 0 ? 12 : 27}" customWidth="1"/>`).join('')}</cols><sheetData>${rows.map((cells, r) => `<row r="${r + 1}">${cells.map((value, c) => `<c r="${columnName(c)}${r + 1}" t="inlineStr"${r === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
}

/** GWG-CONTROL-EXPORT-001. Every cell is explicitly text: ID numbers keep
 * leading zeroes and untrusted names cannot become spreadsheet formulas. */
export function createGwgControlXlsx(rows: readonly ControlRow[]): Uint8Array {
  if (rows.length > CONTROL_ROW_LIMIT)
    throw new Error('Mehr als 10.000 Detailzeilen sind nicht zulässig.');
  const grouped = new Map<string, ControlRow[]>();
  for (const row of rows) {
    const entries = grouped.get(row.groupId) ?? [];
    entries.push(row);
    grouped.set(row.groupId, entries);
  }
  // Only the summary is abbreviated; every mandate value remains in Details.
  const unique = (values: string[]) => {
    const value = [...new Set(values.filter(Boolean))].join(' · ');
    return value.length <= 32_767
      ? value
      : `${value.slice(0, 32_000)} … (weitere Angaben im Blatt Nachweisdetails)`;
  };
  const people = [
    [
      'Personengruppe',
      'Name(n) in sichtbaren Mandaten',
      'Sichtbare Mandanten',
      'Unternehmen / Mandanten',
      'Kontrollstatus',
    ],
    ...[...grouped].map(([id, details]) => [
      id,
      unique(details.map((row) => row.personName)),
      String(new Set(details.map((row) => row.clientId)).size),
      unique(details.map((row) => row.clientName)),
      unique(details.map((row) => CONTROL_STATE_LABELS[row.state])),
    ]),
  ];
  const details = [
    [
      'Personengruppe',
      'Person',
      'Geburtsdatum',
      'Unternehmen / Mandant',
      'DATEV-Mandantennummer',
      'Rolle(n)',
      'Ausweistyp',
      'Ausweisnummer',
      'Gültig bis',
      'Ausweisprüfung durch',
      'Ausweisprüfung am',
      'GwG-Freigabe durch',
      'GwG-Freigabe am',
      'GwG-Prüfstatus',
      'Kontrollstatus',
    ],
    ...rows.map((row) => [
      row.groupId,
      row.personName,
      row.birthDate,
      row.clientName,
      row.datevNo,
      row.roles.join(', '),
      row.documentType,
      row.number,
      row.expiryDate,
      row.identityReviewedBy,
      row.identityReviewedAt,
      row.approvedBy,
      row.approvedAt,
      row.checkStatus,
      row.missingPerson ? 'Keine Person erfasst' : CONTROL_STATE_LABELS[row.state],
    ]),
  ];
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, content: string) => {
    files[path] = strToU8(content);
  };
  put(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  );
  put(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  put(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Personenübersicht" sheetId="1" r:id="rId1"/><sheet name="Nachweisdetails" sheetId="2" r:id="rId2"/></sheets></workbook>',
  );
  put(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  );
  put(
    'xl/styles.xml',
    '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
  );
  put('xl/worksheets/sheet1.xml', sheet(people));
  put('xl/worksheets/sheet2.xml', sheet(details));
  return zipSync(files, { level: 6 });
}
