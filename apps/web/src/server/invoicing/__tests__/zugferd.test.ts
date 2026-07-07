import { describe, it, expect } from 'vitest';
import { generateZugferdPdf } from '../zugferd';
import { generateXRechnungCii } from '../xrechnung';
import { SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER } from '../sample-fixture';

describe('generateZugferdPdf — Factur-X-Hybrid (iter/P2-8)', () => {
  it('bettet die XML als „Alternative" ein und trägt den Factur-X-XMP-Block', async () => {
    const cii = generateXRechnungCii(SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER);
    const pdfBytes = await generateZugferdPdf(SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER, cii);
    const raw = Buffer.from(pdfBytes).toString('latin1');

    // Gültiges PDF.
    expect(raw.startsWith('%PDF-')).toBe(true);
    // Factur-X-XMP-Metadatenstrom (Stream-Objekt, unkomprimiert): Namespace +
    // Kernfelder, an denen konforme Verarbeiter das Hybrid erkennen.
    expect(raw).toContain('urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#');
    expect(raw).toContain('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>');
    expect(raw).toContain('<fx:DocumentType>INVOICE</fx:DocumentType>');
    expect(raw).toContain('<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>');
    // BEWUSST kein PDF/A-3-Anspruch (nicht eingebettete Standard-Fonts) — die
    // XMP darf kein pdfaid:part behaupten.
    expect(raw).not.toContain('pdfaid:part');
  });
});
