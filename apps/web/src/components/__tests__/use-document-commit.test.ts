import { describe, expect, it, vi } from 'vitest';

import { commitDocumentUpload } from '../use-document-commit';

describe('commitDocumentUpload', () => {
  it('returns the validated document id', async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ documentId: 'document-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const formData = new FormData();

    await expect(commitDocumentUpload(formData, request)).resolves.toEqual({
      documentId: 'document-1',
    });
    expect(request).toHaveBeenCalledWith('/api/staff/documents/commit', {
      method: 'POST',
      body: formData,
    });
  });

  it('uses the API error and rejects malformed success responses', async () => {
    const failed = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'Scan fehlgeschlagen' }), { status: 422 }),
      );
    await expect(commitDocumentUpload(new FormData(), failed)).rejects.toThrow(
      'Scan fehlgeschlagen',
    );

    const malformed = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(commitDocumentUpload(new FormData(), malformed)).rejects.toThrow(
      'keine Dokument-ID',
    );
  });
});
