// Review-Finding F-09: Upload-Actions lesen Dateien binär aus FormData und
// prüfen sie gegen die Grenze ihrer Upload-Art.
import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES_BY_KIND } from '@/lib/upload-limits.mjs';
import { readUploadFile } from '../upload-file';

const MIB = 1024 * 1024;

function form(size: number | null, name = 'beleg.pdf'): FormData {
  const data = new FormData();
  if (size !== null) {
    data.set('file', new File([new Uint8Array(size).fill(7)], name, { type: 'application/pdf' }));
  }
  return data;
}

describe('readUploadFile', () => {
  it.each([
    ['bwaXlsx', 19 * MIB],
    ['bwaXlsx', MAX_UPLOAD_BYTES_BY_KIND.bwaXlsx],
    ['portalFormFile', MAX_UPLOAD_BYTES_BY_KIND.portalFormFile],
  ] as const)('liest %s mit %i Bytes vollständig', async (kind, size) => {
    const read = await readUploadFile(form(size), 'file', kind);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.bytes.length).toBe(size);
    expect(read.bytes[size - 1]).toBe(7);
    expect(read).toMatchObject({ fileName: 'beleg.pdf', mimeType: 'application/pdf' });
  });

  it('lehnt ein Byte über der Grenze mit der angezeigten Grenze ab', async () => {
    await expect(
      readUploadFile(form(MAX_UPLOAD_BYTES_BY_KIND.taxFilingPdf + 1), 'file', 'taxFilingPdf', {
        tooLarge: 'PDF zu groß',
      }),
    ).resolves.toEqual({ ok: false, error: 'PDF zu groß (max. 10 MB).' });
  });

  it('meldet fehlende und leere Dateien', async () => {
    await expect(readUploadFile(form(null), 'file', 'portalFormFile')).resolves.toEqual({
      ok: false,
      error: 'Bitte eine Datei auswählen.',
    });
    await expect(readUploadFile(form(0), 'file', 'portalFormFile')).resolves.toEqual({
      ok: false,
      error: 'Die Datei ist leer.',
    });
    const text = new FormData();
    text.set('file', 'kein File');
    await expect(
      readUploadFile(text, 'file', 'portalFormFile', { missing: 'Keine Datei übergeben.' }),
    ).resolves.toEqual({ ok: false, error: 'Keine Datei übergeben.' });
  });
});
