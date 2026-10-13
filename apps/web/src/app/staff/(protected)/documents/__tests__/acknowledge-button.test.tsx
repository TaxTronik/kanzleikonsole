// @vitest-environment jsdom
// P-18: Die Empfangsbestätigung lädt die Dokumentseite einmal neu (über die
// revalidierende Action, siehe acknowledge-access.test.ts), nicht zusätzlich
// per router.refresh(); eine abgelehnte Bestätigung nimmt den optimistischen
// Stand zurück.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ acknowledge: vi.fn(), useRouter: vi.fn() }));

vi.mock('../acknowledge-actions', () => ({ acknowledgeDocumentAction: h.acknowledge }));
vi.mock('next/navigation', () => ({ useRouter: h.useRouter }));

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

  it('bestätigt optimistisch ohne zusätzlichen Router-Refresh und nimmt Ablehnungen zurück', async () => {
    h.acknowledge.mockResolvedValueOnce({ ok: true });
    render(
      <AcknowledgeButton
        documentId={DOCUMENT_ID}
        acknowledgedAt={null}
        acknowledgedByName={null}
        size="md"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Empfang bestätigen' }));
    });
    expect(h.acknowledge).toHaveBeenCalledWith({ documentId: DOCUMENT_ID, acknowledged: true });
    expect(screen.getByText('Empfang bestätigt')).toBeTruthy();
    // Kein Router im Spiel: Die Action-Antwort rendert die Seite neu.
    expect(h.useRouter).not.toHaveBeenCalled();

    h.acknowledge.mockResolvedValueOnce({ ok: false, error: 'Dokument nicht gefunden.' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Empfang bestätigt am/ }));
    });
    expect(h.acknowledge).toHaveBeenLastCalledWith({
      documentId: DOCUMENT_ID,
      acknowledged: false,
    });
    // Abgelehnt: zurück auf den bestätigten Stand.
    expect(screen.getByText('Empfang bestätigt')).toBeTruthy();
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
