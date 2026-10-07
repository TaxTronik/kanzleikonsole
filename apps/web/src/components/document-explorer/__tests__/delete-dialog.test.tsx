import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/staff/(protected)/documents/actions', () => ({
  softDeleteDocumentsAction: vi.fn(),
}));
vi.mock('@/components/ui/modal', () => ({
  Modal: ({ children }: { children: unknown }) => children,
}));

import { documentTier } from '@taxtronik/storage/tiers';
import {
  DeleteDocumentsDialog,
  DeleteDocumentsPanel,
  retentionNotes,
  softDeleteDocuments,
} from '../delete-dialog';

const GOBD = { id: 'doc-1', title: 'Rechnung 1', classification: 'GOBD_INVOICE' };
const GWG = { id: 'doc-2', title: 'Ausweis', classification: 'GWG_EVIDENCE' };
const NOTE = { id: 'doc-3', title: 'Notiz', classification: 'GENERAL' };
const noop = () => undefined;

/** Bulk-Action-Attrappe: lehnt die übergebenen IDs mit `reason` ab. */
function bulkDelete(rejections: Record<string, string> = {}) {
  return vi.fn(async ({ documentIds }: { documentIds: string[]; reason?: string }) => {
    const rejected = documentIds
      .filter((id) => rejections[id])
      .map((id) => ({ id, error: rejections[id]! }));
    return {
      ok: rejected.length === 0,
      done: documentIds.length - rejected.length,
      rejected,
    };
  });
}

describe('gemeinsamer Lösch-Dialog (mit Grund)', () => {
  // P-18: eine Bulk-Action für die ganze Auswahl statt einer Action je Dokument.
  it('löscht die Auswahl mit einem Aufruf und demselben gekürzten Grund', async () => {
    const softDeleteMany = bulkDelete();

    await expect(
      softDeleteDocuments([GOBD, NOTE], '  Dublette  ', softDeleteMany),
    ).resolves.toEqual({ ok: true });
    expect(softDeleteMany).toHaveBeenCalledTimes(1);
    expect(softDeleteMany).toHaveBeenCalledWith({
      documentIds: ['doc-1', 'doc-3'],
      reason: 'Dublette',
    });
  });

  it('sendet keinen leeren Grund', async () => {
    const softDeleteMany = bulkDelete();
    await softDeleteDocuments([NOTE], '   ', softDeleteMany);
    expect(softDeleteMany).toHaveBeenCalledWith({ documentIds: ['doc-3'], reason: undefined });
  });

  it('meldet Einzel- und Teilfehler verständlich', async () => {
    const failing = bulkDelete({ 'doc-2': 'GwG-Nachweis ist zugeordnet.' });
    await expect(softDeleteDocuments([GWG], '', failing)).resolves.toEqual({
      ok: false,
      error: 'GwG-Nachweis ist zugeordnet.',
    });
    await expect(softDeleteDocuments([GOBD, GWG, NOTE], '', failing)).resolves.toEqual({
      ok: false,
      error: '2 gelöscht, 1 abgelehnt:\nGwG-Nachweis ist zugeordnet.',
    });
  });

  it('zeigt einen Fehler vor jeder Verarbeitung unverändert an', async () => {
    const expired = vi.fn(async () => ({
      ok: false,
      done: 0,
      rejected: [],
      error: 'Nicht eingeloggt.',
    }));
    await expect(softDeleteDocuments([GOBD, NOTE], '', expired)).resolves.toEqual({
      ok: false,
      error: 'Nicht eingeloggt.',
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

  // R-14: dieselbe Stufenregel wie Explorer-Badge und Detailseite (documentTier),
  // nicht der Namenspräfix der Klassifikation.
  it.each([
    ['GoBD-Typ mit Allgemein-Klassifikation', { classification: 'GENERAL', tier: 'GOBD' }, 'GOBD'],
    ['GwG-Typ ohne GwG-Klassifikation', { classification: 'GENERAL', tier: 'GWG' }, 'GWG'],
    [
      'ungeschützter Typ trotz GoBD-Klassifikation',
      { classification: 'GOBD_TAX', tier: 'NONE' },
      'NONE',
    ],
    ['Altbestand ohne Typ (GoBD)', { classification: 'GOBD_INVOICE', tier: null }, 'GOBD'],
    ['Altbestand ohne Typ (GwG)', { classification: 'GWG_EVIDENCE' }, 'GWG'],
  ] as const)('leitet den Hinweis aus der Schutzstufe ab: %s', (_case, fields, tier) => {
    const doc = { id: 'doc-9', title: 'Beleg', ...fields };
    expect(documentTier(doc.classification, 'tier' in doc ? doc.tier : undefined)).toBe(tier);

    const notes = retentionNotes([doc]).join(' ');

    expect(notes.includes('COMPLIANCE-Lock')).toBe(tier === 'GOBD');
    expect(notes.includes('GwG-Vernichtung')).toBe(tier === 'GWG');
    expect(notes.includes('entfernt die gespeicherten Bytes nicht')).toBe(tier === 'NONE');
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
