import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/staff/(protected)/documents/actions', () => ({
  softDeleteDocumentAction: vi.fn(),
}));
vi.mock('@/components/ui/modal', () => ({
  Modal: ({ children }: { children: unknown }) => children,
}));

import { DeleteDocumentsDialog, DeleteDocumentsPanel, softDeleteDocuments } from '../delete-dialog';

const GOBD = { id: 'doc-1', title: 'Rechnung 1', classification: 'GOBD_INVOICE' };
const GWG = { id: 'doc-2', title: 'Ausweis', classification: 'GWG_EVIDENCE' };
const NOTE = { id: 'doc-3', title: 'Notiz', classification: 'GENERAL' };
const noop = () => undefined;

describe('gemeinsamer Lösch-Dialog (mit Grund)', () => {
  it('löscht jedes Dokument der Auswahl mit demselben gekürzten Grund', async () => {
    const softDelete = vi.fn(async () => ({ ok: true }));

    await expect(softDeleteDocuments([GOBD, NOTE], '  Dublette  ', softDelete)).resolves.toEqual({
      ok: true,
    });
    expect(softDelete).toHaveBeenCalledWith({ documentId: 'doc-1', reason: 'Dublette' });
    expect(softDelete).toHaveBeenCalledWith({ documentId: 'doc-3', reason: 'Dublette' });
  });

  it('sendet keinen leeren Grund', async () => {
    const softDelete = vi.fn(async () => ({ ok: true }));
    await softDeleteDocuments([NOTE], '   ', softDelete);
    expect(softDelete).toHaveBeenCalledWith({ documentId: 'doc-3', reason: undefined });
  });

  it('meldet Einzel- und Teilfehler verständlich', async () => {
    const failing = vi.fn(async ({ documentId }: { documentId: string }) =>
      documentId === 'doc-2' ? { ok: false, error: 'GwG-Nachweis ist zugeordnet.' } : { ok: true },
    );
    await expect(softDeleteDocuments([GWG], '', failing)).resolves.toEqual({
      ok: false,
      error: 'GwG-Nachweis ist zugeordnet.',
    });
    await expect(softDeleteDocuments([GOBD, GWG, NOTE], '', failing)).resolves.toEqual({
      ok: false,
      error: '2 gelöscht, 1 abgelehnt:\nGwG-Nachweis ist zugeordnet.',
    });
  });

  it('zeigt Grund-Feld und GoBD-Hinweis für ein Dokument', () => {
    const html = renderToStaticMarkup(
      <DeleteDocumentsPanel docs={[GOBD]} onClose={noop} onDone={noop} />,
    );
    expect(html).toContain('Dokument löschen');
    expect(html).toContain('„Rechnung 1&quot; wird aus den Listen ausgeblendet.');
    expect(html).toContain('COMPLIANCE-Lock');
    expect(html).toContain('placeholder="Grund (optional)"');
    expect(html).toContain('maxLength="500"');
  });

  it('fasst eine Mehrfachauswahl zusammen und nennt alle Aufbewahrungsarten', () => {
    const html = renderToStaticMarkup(
      <DeleteDocumentsDialog docs={[GOBD, GWG, NOTE]} onClose={noop} onDone={noop} />,
    );
    expect(html).toContain('3 Dokumente löschen');
    expect(html).toContain('COMPLIANCE-Lock');
    expect(html).toContain('GwG-Vernichtung');
    expect(html).toContain('placeholder="Grund (optional)"');
  });

  it('beide Explorer-Varianten löschen nur über diesen Dialog', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const view of ['../browser-view.tsx', '../embedded-view.tsx']) {
      const source = read(view);
      expect(source, view).toContain('<DeleteDocumentsDialog');
      expect(source, view).not.toContain('softDeleteDocumentAction');
      expect(source, view).not.toContain('DeleteDocModal');
    }
    expect(read('../../document-dialogs.tsx')).not.toContain('softDeleteDocumentAction');
  });
});
