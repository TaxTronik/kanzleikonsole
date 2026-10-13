// @vitest-environment jsdom
// Fachkatalog: GWG-RISK-REVIEW-001
// GwG-Entscheidungsbereich als Verhaltenstest (B-08, Welle 15) statt
// Quelltextprüfung: Anzeige des Übergabezeitpunkts in Kanzlei-Zeit, sofortiger
// Live-Wechsel nach Einreichung und Entscheidung sowie Aktualisierung der
// Benachrichtigungsglocke. Ersetzt auch die entsprechenden Teile aus
// ui-state.test.ts.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onNotificationsChanged } from '@/lib/live-events';

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  submit: vi.fn(),
  verify: vi.fn(),
  reject: vi.fn(),
}));

const router = { refresh: h.refresh };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../actions', () => ({
  submitCheckForReviewAction: h.submit,
  verifyCheckAction: h.verify,
  rejectCheckAction: h.reject,
}));

import { GwgDecisionForms } from '../decision-forms';
import { GwgEditStateProvider, GwgLiveStatusBadge } from '../edit-state-context';

type Props = Parameters<typeof GwgDecisionForms>[0];

function renderForms(props: Partial<Props> = {}) {
  return render(
    <GwgEditStateProvider initialStatus={props.status ?? 'IN_REVIEW'}>
      <GwgLiveStatusBadge />
      <GwgDecisionForms
        checkId="check-1"
        clientId="client-1"
        status="IN_REVIEW"
        reviewSubmittedAt="2026-10-06T08:00:00.000Z"
        canVerify
        reviewSnapshotHash="hash-1"
        {...props}
      />
    </GwgEditStateProvider>,
  );
}

let notificationsChanged: ReturnType<typeof vi.fn>;
let unsubscribe: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  notificationsChanged = vi.fn();
  unsubscribe = onNotificationsChanged(notificationsChanged);
});

afterEach(() => {
  unsubscribe();
});

describe('GwG-Entscheidungsanzeige', () => {
  it('formatiert den Übergabezeitpunkt mit der festen Kanzlei-Zeitzone', () => {
    renderForms({ canVerify: false });
    // 08:00 UTC = 10:00 Europe/Berlin (MESZ), unabhängig von der Prozess-Zeitzone.
    expect(screen.getByText('Zur Freigabe eingereicht am 06.10.26, 10:00.')).toBeTruthy();
  });

  it('wechselt nach erfolgreicher Einreichung sofort live auf IN_REVIEW', async () => {
    h.submit.mockResolvedValueOnce({ ok: true });
    renderForms({ status: 'DRAFT', reviewSubmittedAt: null, reviewSnapshotHash: null });
    expect(screen.getByText('Entwurf')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Zur Freigabe einreichen' }));
    });
    expect(Object.fromEntries(h.submit.mock.calls[0]![1] as FormData)).toEqual({
      checkId: 'check-1',
      clientId: 'client-1',
    });
    await waitFor(() => expect(screen.getByText('In Prüfung')).toBeTruthy());
    expect(h.refresh).toHaveBeenCalledOnce();
    // Bis Hash und Props nachgezogen sind, bleibt die Freigabe gesperrt.
    expect(screen.getByText('Die gebundene Prüfansicht wird aktualisiert…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Verifizieren/ })).toBeNull();
  });

  it('zeigt Fehler der Einreichung, ohne den Status zu wechseln', async () => {
    h.submit.mockResolvedValueOnce({ ok: false, error: 'Nachweise unvollständig.' });
    renderForms({ status: 'DRAFT', reviewSubmittedAt: null, reviewSnapshotHash: null });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Zur Freigabe einreichen' }));
    });
    expect((await screen.findByRole('alert')).textContent).toBe('Nachweise unvollständig.');
    expect(screen.getByText('Entwurf')).toBeTruthy();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('aktualisiert nach einer Verifizierung Status und Benachrichtigungsglocke sofort', async () => {
    h.verify.mockResolvedValueOnce({ ok: true });
    renderForms();
    fireEvent.click(screen.getByRole('checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Verifizieren und Mandant aktivieren' }));
    });
    expect(Object.fromEntries(h.verify.mock.calls[0]![1] as FormData)).toEqual({
      checkId: 'check-1',
      clientId: 'client-1',
      reviewSnapshotHash: 'hash-1',
      reviewSnapshotVersion: '2',
      professionalAttestation: 'confirmed',
    });
    await waitFor(() => expect(screen.getByText('Verifiziert')).toBeTruthy());
    expect(screen.getByRole('status').textContent).toMatch(/GwG-Prüfung verifiziert/);
    expect(notificationsChanged).toHaveBeenCalledOnce();
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it('aktualisiert nach einer Ablehnung Status und Benachrichtigungsglocke sofort', async () => {
    h.reject.mockResolvedValueOnce({ ok: true });
    renderForms();
    fireEvent.change(screen.getByLabelText('Ablehnungsgrund'), {
      target: { value: 'Ausweis unleserlich' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ablehnen' }));
    });
    expect(Object.fromEntries(h.reject.mock.calls[0]![1] as FormData)).toEqual({
      checkId: 'check-1',
      clientId: 'client-1',
      reason: 'Ausweis unleserlich',
    });
    await waitFor(() => expect(screen.getByText('Abgelehnt')).toBeTruthy());
    expect(notificationsChanged).toHaveBeenCalledOnce();
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it('meldet abgelehnte Entscheidungen ohne Glocken- oder Statuswechsel', async () => {
    h.verify.mockResolvedValueOnce({ ok: false, error: 'Kein Berufsträger.' });
    renderForms();
    fireEvent.click(screen.getByRole('checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Verifizieren und Mandant aktivieren' }));
    });
    expect((await screen.findByRole('alert')).textContent).toBe('Kein Berufsträger.');
    expect(screen.getByText('In Prüfung')).toBeTruthy();
    expect(notificationsChanged).not.toHaveBeenCalled();
  });
});
