import { describe, it, expect } from 'vitest';
import { extractText, UnsupportedDocumentTypeError } from '../extract-text';

describe('extractText', () => {
  it('gibt text/* normalisiert zurück (CRLF + Rand-Whitespace)', async () => {
    const out = await extractText(Buffer.from('Hallo\r\nWelt   \n'), 'text/plain');
    expect(out).toBe('Hallo\nWelt');
  });

  it('strippt geschützte Leerzeichen (U+00A0)', async () => {
    const nbsp = String.fromCharCode(0xa0);
    const out = await extractText(Buffer.from('A' + nbsp + 'B'), 'text/plain');
    expect(out).toBe('A B');
  });

  it('respektiert mime mit charset-Parameter', async () => {
    const out = await extractText(Buffer.from('x'), 'text/plain; charset=utf-8');
    expect(out).toBe('x');
  });

  it('wirft UnsupportedDocumentTypeError bei Alt-.doc', async () => {
    await expect(extractText(Buffer.from('x'), 'application/msword')).rejects.toBeInstanceOf(
      UnsupportedDocumentTypeError,
    );
  });

  it('wirft UnsupportedDocumentTypeError bei unbekanntem Typ', async () => {
    await expect(extractText(Buffer.from('x'), 'image/png')).rejects.toBeInstanceOf(
      UnsupportedDocumentTypeError,
    );
  });
});
