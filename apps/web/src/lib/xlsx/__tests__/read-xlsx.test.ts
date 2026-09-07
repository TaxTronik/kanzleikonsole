// =============================================================================
// Tests fuer den XLSX-Reader.
//
// Die Fixtures werden im Test selbst als ZIP gebaut. Damit haengt die Suite an
// keiner Binaerdatei im Repo und die einzelnen SpreadsheetML-Konstrukte sind im
// Testcode sichtbar — inkl. der Varianten, die reale DATEV-Exporte erzeugen.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readXlsx, XlsxReadError, parseCellReference, serialToDate } from '../read-xlsx';
import { decodeXmlEntities, parseXml } from '../xml';

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Target="worksheets/sheet2.xml"/>
</Relationships>`;

function workbookXml(...names: string[]): string {
  const sheets = names
    .map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheets}</sheets>
</workbook>`;
}

function sheetXml(rows: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet><sheetData>${rows}</sheetData></worksheet>`;
}

interface BuildOptions {
  sheets: string[];
  sharedStrings?: string;
  styles?: string;
  omitRels?: boolean;
}

function buildXlsx(options: BuildOptions): Uint8Array {
  const names = options.sheets.map((_, i) => `Tabelle${i + 1}`);
  const files: Record<string, Uint8Array> = {
    'xl/workbook.xml': strToU8(workbookXml(...names)),
  };
  if (!options.omitRels) files['xl/_rels/workbook.xml.rels'] = strToU8(WORKBOOK_RELS);
  options.sheets.forEach((xml, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(xml);
  });
  if (options.sharedStrings) files['xl/sharedStrings.xml'] = strToU8(options.sharedStrings);
  if (options.styles) files['xl/styles.xml'] = strToU8(options.styles);
  return zipSync(files);
}

describe('parseCellReference', () => {
  it('rechnet Spaltenbuchstaben in 0-basierte Indizes um', () => {
    expect(parseCellReference('A1')).toEqual({ row: 0, column: 0 });
    expect(parseCellReference('D12')).toEqual({ row: 11, column: 3 });
    expect(parseCellReference('AA3')).toEqual({ row: 2, column: 26 });
    expect(parseCellReference('XFD1')).toEqual({ row: 0, column: 16383 });
  });

  it('weist unbrauchbare Referenzen ab', () => {
    expect(parseCellReference(undefined)).toBeNull();
    expect(parseCellReference('')).toBeNull();
    expect(parseCellReference('A0')).toBeNull();
    expect(parseCellReference('1A')).toBeNull();
  });
});

describe('serialToDate', () => {
  it('bildet das Excel-Serial auf UTC ab', () => {
    expect(serialToDate(45658).toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(serialToDate(45658.5).toISOString()).toBe('2025-01-01T12:00:00.000Z');
  });

  it('korrigiert die Serien vor Excels Phantom-Schalttag', () => {
    expect(serialToDate(1).toISOString()).toBe('1900-01-01T00:00:00.000Z');
    expect(serialToDate(59).toISOString()).toBe('1900-02-28T00:00:00.000Z');
    // 60 ist der 29.02.1900, den es nie gab — Excel fuehrt ihn trotzdem.
    expect(serialToDate(60).toISOString()).toBe('1900-02-28T00:00:00.000Z');
    expect(serialToDate(61).toISOString()).toBe('1900-03-01T00:00:00.000Z');
  });
});

describe('decodeXmlEntities', () => {
  it('loest benannte und numerische Referenzen auf', () => {
    expect(decodeXmlEntities('A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(
      'A & B <c> "d" \'e\'',
    );
    expect(decodeXmlEntities('&#196;&#x00e4;')).toBe('Ää');
  });

  it('laesst Unbekanntes unveraendert', () => {
    expect(decodeXmlEntities('&nbsp;&foo;')).toBe('&nbsp;&foo;');
  });
});

describe('parseXml', () => {
  it('ignoriert Kommentare und liefert CDATA als Text', () => {
    const seen: string[] = [];
    parseXml('<a><!-- weg --><b><![CDATA[roh & <ungefiltert>]]></b></a>', {
      onText: (t) => seen.push(t),
    });
    expect(seen.join('')).toBe('roh & <ungefiltert>');
  });

  it('erkennt `>` innerhalb von Attributwerten', () => {
    const attrs: Record<string, string>[] = [];
    parseXml('<c r="A1" f="a &gt; b"/>', { onOpen: (_n, a) => attrs.push({ ...a }) });
    expect(attrs).toEqual([{ r: 'A1', f: 'a > b' }]);
  });

  it('meldet Self-Closing-Tags als Open und Close', () => {
    const events: string[] = [];
    parseXml('<row><c/></row>', {
      onOpen: (n) => events.push(`+${n}`),
      onClose: (n) => events.push(`-${n}`),
    });
    expect(events).toEqual(['+row', '+c', '-c', '-row']);
  });
});

describe('readXlsx', () => {
  it('liest Shared Strings, Zahlen, Wahrheitswerte und Inline-Strings', () => {
    const data = buildXlsx({
      sharedStrings: `<sst><si><t>Umsatz</t></si><si><r><t>Roh</t></r><r><t>ertrag</t></r></si></sst>`,
      sheets: [
        sheetXml(
          `<row r="1">
             <c r="A1" t="s"><v>0</v></c>
             <c r="B1" t="s"><v>1</v></c>
             <c r="C1" t="inlineStr"><is><t>Direkt</t></is></c>
           </row>
           <row r="2">
             <c r="A2"><v>1234.5</v></c>
             <c r="B2" t="b"><v>1</v></c>
             <c r="C2" t="b"><v>0</v></c>
           </row>`,
        ),
      ],
    });

    const [sheet] = readXlsx(data);
    expect(sheet!.name).toBe('Tabelle1');
    expect(sheet!.rows).toEqual([
      ['Umsatz', 'Rohertrag', 'Direkt'],
      [1234.5, true, false],
    ]);
  });

  it('nimmt das zwischengespeicherte Formel-Ergebnis, nicht die Formel', () => {
    const data = buildXlsx({
      sheets: [
        sheetXml(
          `<row r="1">
             <c r="A1"><f>SUM(B1:C1)</f><v>42</v></c>
             <c r="B1" t="e"><f>1/0</f><v>#DIV/0!</v></c>
             <c r="C1" t="str"><f>CONCAT("a","b")</f><v>ab</v></c>
           </row>`,
        ),
      ],
    });

    // Fehlerzellen liefern null statt `#DIV/0!` in die Auswertung.
    expect(readXlsx(data)[0]!.rows).toEqual([[42, null, 'ab']]);
  });

  it('bemisst das Raster an den wertetragenden Zellen', () => {
    // Nachlaufende Leer-/Fehlerzellen erweitern das Blatt nicht — sonst blaehen
    // die in Exporten ueblichen formatierten Leerzellen die Vorschau auf.
    const data = buildXlsx({
      sheets: [
        sheetXml(
          `<row r="1"><c r="A1"><v>1</v></c><c r="C1" s="2"/><c r="D1" t="e"><v>#N/A</v></c></row>`,
        ),
      ],
    });
    expect(readXlsx(data)[0]!.rows).toEqual([[1]]);
  });

  it('fuellt Luecken in Zeilen und Spalten mit null', () => {
    const data = buildXlsx({
      sheets: [
        sheetXml(
          `<row r="1"><c r="A1"><v>1</v></c><c r="D1"><v>4</v></c></row>
           <row r="3"><c r="B3"><v>2</v></c></row>`,
        ),
      ],
    });

    expect(readXlsx(data)[0]!.rows).toEqual([
      [1, null, null, 4],
      [null, null, null, null],
      [null, 2, null, null],
    ]);
  });

  it('erkennt Datumszellen ueber styles.xml, Zahlen bleiben Zahlen', () => {
    const styles = `<styleSheet>
      <numFmts><numFmt numFmtId="164" formatCode="dd\\.mm\\.yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00 &quot;EUR&quot;"/></numFmts>
      <cellStyleXfs><xf numFmtId="14"/></cellStyleXfs>
      <cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs>
    </styleSheet>`;
    const data = buildXlsx({
      styles,
      sheets: [
        sheetXml(
          `<row r="1">
             <c r="A1" s="0"><v>45658</v></c>
             <c r="B1" s="1"><v>45658</v></c>
             <c r="C1" s="2"><v>45658</v></c>
             <c r="D1" s="3"><v>45658</v></c>
           </row>`,
        ),
      ],
    });

    const [a, b, c, d] = readXlsx(data)[0]!.rows[0]!;
    expect(a).toBe(45658);
    // `cellStyleXfs` darf die Indizes von `cellXfs` nicht verschieben.
    expect(b).toBeInstanceOf(Date);
    expect((b as Date).toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(c).toBeInstanceOf(Date);
    // Waehrungsformat enthaelt kein Datums-Token — der Literal-Teil zaehlt nicht.
    expect(d).toBe(45658);
  });

  it('ignoriert numFmt ausserhalb von numFmts (bedingte Formatierung)', () => {
    // `dxfs` traegt die Formate der bedingten Formatierung. Deren numFmtId
    // adressiert NICHT die globale Formattabelle. Ohne Scope-Pruefung wuerde
    // ein Datums-Code auf ID 0 ("General") jede blanke Zahl der Mappe zum
    // Datum machen — im DATEV-Import faellt dann jede Position heraus.
    const styles = `<styleSheet>
      <numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
      <cellXfs count="1"><xf numFmtId="0"/></cellXfs>
      <dxfs count="1"><dxf><numFmt numFmtId="0" formatCode="DD.MM.YYYY"/></dxf></dxfs>
    </styleSheet>`;
    const data = buildXlsx({
      styles,
      sheets: [sheetXml(`<row r="1"><c r="A1" s="0"><v>15000</v></c></row>`)],
    });

    expect(readXlsx(data)[0]!.rows).toEqual([[15000]]);
  });

  it('liest mehrere Arbeitsblaetter in Reihenfolge der Mappe', () => {
    const data = buildXlsx({
      sharedStrings: `<sst><si><t>eins</t></si></sst>`,
      sheets: [
        sheetXml(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`),
        sheetXml(`<row r="1"><c r="A1"><v>2</v></c></row>`),
      ],
    });

    const sheets = readXlsx(data);
    expect(sheets.map((s) => s.name)).toEqual(['Tabelle1', 'Tabelle2']);
    expect(sheets[0]!.rows).toEqual([['eins']]);
    expect(sheets[1]!.rows).toEqual([[2]]);
  });

  it('BWA-IMPORT-MAPPING-001: ordnet Blattnamen den Relationship-Zielen statt Dateinummern zu', () => {
    const data = zipSync({
      'xl/workbook.xml': strToU8(workbookXml('Umsatz', 'Vorjahr')),
      'xl/_rels/workbook.xml.rels': strToU8(`<Relationships>
        <Relationship Id="rId1" Target="worksheets/sheet2.xml"/>
        <Relationship Id="rId2" Target="worksheets/sheet1.xml"/>
      </Relationships>`),
      'xl/worksheets/sheet1.xml': strToU8(sheetXml('<row><c r="A1"><v>100</v></c></row>')),
      'xl/worksheets/sheet2.xml': strToU8(sheetXml('<row><c r="A1"><v>200</v></c></row>')),
    });
    expect(readXlsx(data)).toEqual([
      { name: 'Umsatz', rows: [[200]] },
      { name: 'Vorjahr', rows: [[100]] },
    ]);
  });

  it.each(['worksheets/export.xml', './worksheets/export.xml', '/xl/worksheets/export.xml'])(
    'liest das tatsächlich verknüpfte Blatt unter %s',
    (target) => {
      const data = zipSync({
        'xl/workbook.xml': strToU8(workbookXml('Export')),
        'xl/_rels/workbook.xml.rels': strToU8(
          `<Relationships><Relationship Id="rId1" Target="${target}"/></Relationships>`,
        ),
        'xl/worksheets/export.xml': strToU8(sheetXml('<row><c r="A1"><v>42</v></c></row>')),
      });
      expect(readXlsx(data)).toEqual([{ name: 'Export', rows: [[42]] }]);
    },
  );

  it('faellt ohne Relationships auf die konventionelle Ablage zurueck', () => {
    const data = buildXlsx({
      omitRels: true,
      sheets: [sheetXml(`<row r="1"><c r="A1"><v>7</v></c></row>`)],
    });
    expect(readXlsx(data)[0]!.rows).toEqual([[7]]);
  });

  it('behandelt Sonderzeichen und erhaltenen Leerraum korrekt', () => {
    const data = buildXlsx({
      sharedStrings: `<sst><si><t xml:space="preserve"> Müller &amp; Söhne </t></si></sst>`,
      sheets: [sheetXml(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`)],
    });
    expect(readXlsx(data)[0]!.rows).toEqual([[' Müller & Söhne ']]);
  });

  it('ignoriert phonetische Hinweise in Shared Strings', () => {
    const data = buildXlsx({
      sharedStrings: `<sst><si><t>Kanji</t><rPh sb="0" eb="2"><t>ignorieren</t></rPh></si></sst>`,
      sheets: [sheetXml(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`)],
    });
    expect(readXlsx(data)[0]!.rows).toEqual([['Kanji']]);
  });

  it('dekomprimiert nur die ausgewerteten Teile', () => {
    // Eingebettete Medien und OLE-Objekte machen in echten Mappen den Loewen-
    // anteil aus und werden von diesem Reader nie gelesen.
    const files: Record<string, Uint8Array> = {
      'xl/workbook.xml': strToU8(workbookXml('Tabelle1')),
      'xl/_rels/workbook.xml.rels': strToU8(WORKBOOK_RELS),
      'xl/worksheets/sheet1.xml': strToU8(sheetXml(`<row r="1"><c r="A1"><v>7</v></c></row>`)),
      'xl/media/image1.bin': new Uint8Array(2 * 1024 * 1024),
      'docProps/thumbnail.jpeg': new Uint8Array(512 * 1024),
    };
    expect(readXlsx(zipSync(files))[0]!.rows).toEqual([[7]]);
  });

  it('weist einen Eintrag ab, der das Entpack-Budget sprengt', () => {
    // Zip-Bombe im Kleinen: gut komprimierbarer Riesen-Eintrag. Der Filter muss
    // greifen, BEVOR fflate den Zielpuffer in deklarierter Groesse allokiert.
    const huge = new Uint8Array(65 * 1024 * 1024); // Nullen, komprimiert winzig
    const data = zipSync({
      'xl/workbook.xml': strToU8(workbookXml('Tabelle1')),
      'xl/_rels/workbook.xml.rels': strToU8(WORKBOOK_RELS),
      'xl/worksheets/sheet1.xml': huge,
    });
    expect(() => readXlsx(data)).toThrow(/zu gross/);
  });

  it('wendet das Entpack-Budget auch auf die Workbook-Relationships an', () => {
    const data = buildXlsx({ sheets: [sheetXml('<row><c r="A1"><v>7</v></c></row>')] });
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    // Forge only the declared original size in the ZIP central directory;
    // the fixture stays small and rejection must happen before allocation.
    let patched = false;
    for (let offset = 0; offset + 46 < data.length; offset++) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      const nameLength = view.getUint16(offset + 28, true);
      const name = new TextDecoder().decode(data.subarray(offset + 46, offset + 46 + nameLength));
      if (name !== 'xl/_rels/workbook.xml.rels') continue;
      view.setUint32(offset + 24, 65 * 1024 * 1024, true);
      patched = true;
      break;
    }
    expect(patched).toBe(true);
    expect(() => readXlsx(data)).toThrow(/workbook\.xml\.rels.*zu gross/);
  });

  it('bricht bei nicht lesbarem Container ab', () => {
    expect(() => readXlsx(strToU8('kein zip'))).toThrow(XlsxReadError);
  });

  it('bricht ab, wenn workbook.xml fehlt', () => {
    const data = zipSync({ 'docProps/app.xml': strToU8('<Properties/>') });
    expect(() => readXlsx(data)).toThrow(/workbook\.xml fehlt/);
  });

  it('weist ein Raster ab, das das Zellbudget sprengt', () => {
    // Eine einzelne Zelle am Blattende wuerde sonst ein 1.048.576 x 16.384
    // grosses Raster materialisieren.
    const data = buildXlsx({
      sheets: [sheetXml(`<row r="1048576"><c r="XFD1048576"><v>1</v></c></row>`)],
    });
    expect(() => readXlsx(data)).toThrow(/zu gross/);
  });
});
