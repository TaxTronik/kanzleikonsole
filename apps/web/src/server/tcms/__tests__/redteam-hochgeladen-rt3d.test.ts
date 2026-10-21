// =============================================================================
// Angriffsdurchlauf RT3D (kk-tcms-s11 Punkt 5): n8n-Ereignis document.uploaded
// für Tax-CMS-Uploads. Kein Befund: das Ereignis trägt nur die Schlüssel der
// Upload-Routen plus die Quelle – nie Titel/Dateiname, Inhalt oder Texte des
// Tax-CMS – und dedupliziert je Dokument. Dass ein gescheiterter Upload nichts
// sendet (emit erst nach dem Commit, außerhalb des try/catch), belegt
// hochgeladen-db.test.ts; hier wird die Nutzlast gegen Datenabfluss fixiert.
//
// Fachkatalog: TCMS-NACHWEIS-001
// =============================================================================
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const emit = vi.hoisted(() =>
  vi.fn<
    (
      event: string,
      payload: Record<string, unknown>,
      opts: Record<string, unknown>,
    ) => Promise<{ status: 'OK' }>
  >(async () => ({ status: 'OK' })),
);
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: emit }));

import { tcmsDokumentHochgeladen } from '../hochgeladen';

describe('RT3D: document.uploaded (Tax-CMS)', () => {
  it('sendet nur unkritische Schlüssel und Quelle, keine Namen/Texte', async () => {
    emit.mockClear();
    await tcmsDokumentHochgeladen({
      tenantId: 't-1',
      mandantId: 'm-1',
      dokumentId: 'd-1',
      classification: 'GENERAL',
      quelle: 'tcms-meldung',
    });
    expect(emit).toHaveBeenCalledTimes(1);
    const [ereignis, payload, opts] = emit.mock.calls[0]!;
    expect(ereignis).toBe('document.uploaded');
    // Exakt diese Schlüssel – nichts Darüberhinausgehendes.
    expect(Object.keys(payload).sort()).toEqual(
      ['classification', 'clientId', 'documentId', 'isGobd', 'source', 'tenantId'].sort(),
    );
    expect(payload).toMatchObject({
      tenantId: 't-1',
      clientId: 'm-1',
      documentId: 'd-1',
      classification: 'GENERAL',
      isGobd: false,
      source: 'tcms-meldung',
    });
    const text = JSON.stringify({ payload, opts });
    for (const verboten of [
      'title',
      'titel',
      'dateiname',
      'filename',
      'name',
      'ereignis',
      'code',
    ]) {
      expect(text.toLowerCase().includes(verboten), verboten).toBe(false);
    }
    // Dedupe je Dokument (keine Doppel-Ereignisse bei Wiederholung).
    expect(opts).toMatchObject({ tenantId: 't-1', dedupeKey: 'document.uploaded:d-1' });
  });

  it('die Quelle unterscheidet Nachweis und Meldung', async () => {
    emit.mockClear();
    await tcmsDokumentHochgeladen({
      tenantId: 't-1',
      mandantId: 'm-1',
      dokumentId: 'd-2',
      classification: 'GENERAL',
      quelle: 'tcms-nachweis',
    });
    expect(emit.mock.calls[0]![1]).toMatchObject({ source: 'tcms-nachweis' });
    expect(emit.mock.calls[0]![2]).toMatchObject({ dedupeKey: 'document.uploaded:d-2' });
  });
});
