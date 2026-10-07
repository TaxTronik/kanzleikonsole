// P-18: Die Empfangsbestätigung lädt die Dokumentseite einmal neu (über die
// revalidierende Action), nicht zusätzlich per router.refresh(); eine
// abgelehnte Bestätigung nimmt den optimistischen Stand zurück.
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../acknowledge-actions', () => ({ acknowledgeDocumentAction: vi.fn() }));

import { AcknowledgeButton, submitAcknowledgement } from '../acknowledge-button';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';

describe('AcknowledgeButton', () => {
  it('meldet Erfolg und Ablehnung der Action', async () => {
    const accept = vi.fn(async () => ({ ok: true as const }));
    const reject = vi.fn(async () => ({ ok: false as const, error: 'Dokument nicht gefunden.' }));

    await expect(submitAcknowledgement(DOCUMENT_ID, true, accept)).resolves.toBe(true);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith({ documentId: DOCUMENT_ID, acknowledged: true });
    await expect(submitAcknowledgement(DOCUMENT_ID, false, reject)).resolves.toBe(false);
    expect(reject).toHaveBeenCalledWith({ documentId: DOCUMENT_ID, acknowledged: false });
  });

  it('lädt die Seite nicht zusätzlich per router.refresh() neu', () => {
    const source = readFileSync(new URL('../acknowledge-button.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/router\.refresh|useRouter/);
    // Die Action revalidiert genau die Seite, auf der der Knopf steht.
    const action = readFileSync(new URL('../acknowledge-actions.ts', import.meta.url), 'utf8');
    expect(action).toContain('revalidatePath(`/staff/documents/${parsed.data.documentId}`)');
  });

  it('zeigt den gespeicherten Stand', () => {
    expect(
      renderToStaticMarkup(
        <AcknowledgeButton
          documentId={DOCUMENT_ID}
          acknowledgedAt={null}
          acknowledgedByName={null}
          size="md"
        />,
      ),
    ).toContain('Empfang bestätigen');
    expect(
      renderToStaticMarkup(
        <AcknowledgeButton
          documentId={DOCUMENT_ID}
          acknowledgedAt="2026-10-07T08:00:00.000Z"
          acknowledgedByName="Erika Muster"
          size="md"
        />,
      ),
    ).toContain('Empfang bestätigt');
  });
});
