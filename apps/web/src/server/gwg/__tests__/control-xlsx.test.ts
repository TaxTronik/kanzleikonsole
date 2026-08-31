import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { createGwgControlXlsx } from '../control-xlsx';
import { groupVisibleControlRows, type ControlRow } from '../control-list-model';
const row = (anchor: string, number: string): ControlRow => ({
  rowId: anchor,
  groupId: '',
  anchorId: anchor,
  clientId: anchor,
  clientName: `Firma ${anchor}`,
  datevNo: '00012',
  checkId: 'check',
  checkStatus: 'DRAFT',
  personName: '=HYPERLINK("evil") & <Name>',
  birthDate: '',
  roles: ['Vertreter'],
  documentSetId: 'set',
  documentType: 'PERSONALAUSWEIS',
  number,
  expiryDate: '2030-01-01',
  identityReviewedBy: '',
  identityReviewedAt: '',
  approvedBy: '',
  approvedAt: '',
  state: 'UNCHECKED',
  missingPerson: false,
});
describe('GWG-CONTROL-EXPORT-001 XLSX package', () => {
  it('produces two linked sheets and preserves different mandate IDs as text without formulas', () => {
    const rows = groupVisibleControlRows(
      [row('a', '0012345'), row('b', '0099999')],
      [{ id: 'link', fromAnchorId: 'a', toAnchorId: 'b' }],
    );
    const archive = unzipSync(createGwgControlXlsx(rows));
    const people = strFromU8(archive['xl/worksheets/sheet1.xml']!);
    const details = strFromU8(archive['xl/worksheets/sheet2.xml']!);
    expect(people.match(/<row /g)).toHaveLength(2);
    expect(details.match(/<row /g)).toHaveLength(3);
    expect(people).toContain(rows[0]!.groupId);
    expect(details).toContain(rows[0]!.groupId);
    expect(details).toContain('0012345');
    expect(details).toContain('0099999');
    expect(details).toContain('00012');
    expect(details).toContain('t="inlineStr"');
    expect(details).not.toContain('<f>');
    expect(details).toContain('&amp; &lt;Name&gt;');
    expect(strFromU8(archive['xl/workbook.xml']!)).toContain('name="Personenübersicht"');
    expect(strFromU8(archive['xl/workbook.xml']!)).toContain('name="Nachweisdetails"');
    expect(archive['[Content_Types].xml']).toBeDefined();
    expect(archive['xl/styles.xml']).toBeDefined();
  });
  it('fails closed above the detail cap instead of creating a complete-looking partial workbook', () => {
    expect(() =>
      createGwgControlXlsx(Array.from({ length: 10_001 }, () => row('a', '123'))),
    ).toThrow('10.000');
  });
  it('removes XML-invalid controls while preserving readable Unicode and line breaks', () => {
    const source = {
      ...row('a', '00123'),
      groupId: 'P00001',
      personName: `A${String.fromCharCode(1, 0xffff, 0xd800)}B\tC\nü😀`,
    };
    const archive = unzipSync(createGwgControlXlsx([source]));
    const details = strFromU8(archive['xl/worksheets/sheet2.xml']!);
    expect(details).toContain('AB\tC\nü😀');
    expect(details).not.toContain(String.fromCharCode(1));
    expect(details).not.toContain(String.fromCharCode(0xffff));
  });
  it('allows empty workbooks with headers and valid filters', () => {
    const archive = unzipSync(createGwgControlXlsx([]));
    expect(strFromU8(archive['xl/worksheets/sheet2.xml']!)).toContain('ref="A1:O1"');
  });
  it('bounds a very large group summary while retaining every mandate detail', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      ...row(`anchor-${i}`, `00${i}`),
      groupId: 'P00001',
      clientName: `Firma ${i} ${'a'.repeat(200)}`,
    }));
    const archive = unzipSync(createGwgControlXlsx(rows));
    expect(strFromU8(archive['xl/worksheets/sheet1.xml']!)).toContain(
      'weitere Angaben im Blatt Nachweisdetails',
    );
    const details = strFromU8(archive['xl/worksheets/sheet2.xml']!);
    expect(details.match(/<row /g)).toHaveLength(201);
    expect(details).toContain(rows[199]!.clientName);
  });
});
