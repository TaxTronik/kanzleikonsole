// Fachkatalog: MAIL-INBOX-001
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
vi.mock('@taxtronik/storage', () => ({
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
  detectMimeFromMagicBytes: (bytes: Buffer) =>
    bytes.subarray(0, 4).toString() === '%PDF' ? 'application/pdf' : null,
}));
import { classifyInboundAttachment } from '../attachments';
describe('parse actual PDF syntax before releasing an attachment', () => {
  it('accepts a complete unencrypted PDF and rejects damaged data', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    expect((await classifyInboundAttachment(Buffer.from(await doc.save()))).blocked).toBeNull();
    expect((await classifyInboundAttachment(Buffer.from('%PDF-1.7 broken'))).blocked).toBeTruthy();
  });
  it('rejects an escaped Encrypt name as well as a literal encryption dictionary', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.context.trailerInfo.Encrypt = doc.context.register(
      doc.context.obj({ Filter: PDFName.of('Standard'), V: 1, R: 2, Length: 40 }),
    );
    const original = Buffer.from(await doc.save({ useObjectStreams: false }));
    expect(original.toString('latin1')).toContain('/Encrypt');
    expect((await classifyInboundAttachment(original)).blocked).toBeTruthy();
    const escaped = Buffer.from(
      original.toString('latin1').replace('/Encrypt', '/En#63rypt'),
      'latin1',
    );
    expect((await classifyInboundAttachment(escaped)).blocked).toBeTruthy();
  });
  it('never unpacks an archive or accepts an unrecognized type', async () => {
    expect((await classifyInboundAttachment(Buffer.from('PK archive'))).blocked).toBeTruthy();
  });
});
