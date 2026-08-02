import { describe, expect, it } from 'vitest';
import { canPreviewInline } from '../document-preview-kind';

describe('canPreviewInline', () => {
  it('bietet die Ansicht fuer PDF, Bilder und Text an', () => {
    expect(canPreviewInline('application/pdf', 'RE-2026-001.pdf')).toBe(true);
    expect(canPreviewInline('application/pdf; charset=binary', 'x.pdf')).toBe(true);
    expect(canPreviewInline('image/png', 'scan.png')).toBe(true);
    expect(canPreviewInline('text/plain', 'notiz.txt')).toBe(true);
  });

  it('bietet die Ansicht fuer XLSX an (eigener Reader)', () => {
    expect(
      canPreviewInline(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Auswertung',
      ),
    ).toBe(true);
  });

  it('bietet fuer XRechnung-XML KEINE Ansicht an', () => {
    // `application/xml` steht aus XSS-Gruenden bewusst nicht in der
    // Inline-Whitelist (server/storage/preview-mime.ts). Menschenlesbar ist bei
    // diesen Rechnungen das ZUGFeRD-PDF derselben Rechnung.
    expect(canPreviewInline('application/xml', 'RE-2026-001-xrechnung.xml')).toBe(false);
    expect(canPreviewInline('text/xml', 'rechnung.xml')).toBe(false);
  });

  it('bietet fuer DOCX und unbekannte Typen KEINE Ansicht an', () => {
    expect(
      canPreviewInline(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'brief.docx',
      ),
    ).toBe(false);
    expect(canPreviewInline('application/zip', 'archiv.zip')).toBe(false);
    expect(canPreviewInline(null, 'ohne-typ')).toBe(false);
  });
});
