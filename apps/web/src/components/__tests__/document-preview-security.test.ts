import { describe, expect, it } from 'vitest';
import { detectInlineOfficeKind } from '../document-preview-kind';

describe('document preview security boundary', () => {
  it('never renders DOCX/OOXML inline on the authenticated app origin', () => {
    expect(
      detectInlineOfficeKind(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'harmlos.docx',
      ),
    ).toBeNull();
    expect(detectInlineOfficeKind('application/zip', 'evil.docx')).toBeNull();
  });

  it('keeps the XLSX viewer available', () => {
    expect(
      detectInlineOfficeKind(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'tabelle.xlsx',
      ),
    ).toBe('xlsx');
  });
});
