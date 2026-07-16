'use client';

import { useCallback } from 'react';

export interface DocumentCommitResult {
  documentId: string;
}

export type DocumentCommitFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function commitDocumentUpload(
  formData: FormData,
  request: DocumentCommitFetch = fetch,
): Promise<DocumentCommitResult> {
  const response = await request('/api/staff/documents/commit', {
    method: 'POST',
    body: formData,
  });
  const body = (await response.json().catch(() => ({}))) as {
    documentId?: unknown;
    error?: unknown;
  };
  if (!response.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : `Upload (${response.status})`);
  }
  if (typeof body.documentId !== 'string') {
    throw new Error('Upload-Antwort enthält keine Dokument-ID. Bitte Seite neu laden.');
  }
  return { documentId: body.documentId };
}

export function useDocumentCommit(): (formData: FormData) => Promise<DocumentCommitResult> {
  return useCallback((formData: FormData) => commitDocumentUpload(formData), []);
}
