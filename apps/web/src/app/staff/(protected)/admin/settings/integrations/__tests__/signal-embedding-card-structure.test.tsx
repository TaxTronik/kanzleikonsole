// @vitest-environment jsdom
// Signal-Embedding-Card als Render- und Verhaltenstest (B-08, Welle 15) statt
// Quelltextprüfung; das Laden auf der Integrationsseite prüft
// page-signal-embedding.test.tsx.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { EmbeddingStatusResponse } from '@taxtronik/risk-layer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  trigger: vi.fn(),
  cancel: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('../signal-embedding-actions', () => ({
  triggerSignalEmbeddingAction: h.trigger,
  cancelSignalEmbeddingAction: h.cancel,
  updateSignalEmbeddingScheduleAction: h.schedule,
}));

import { SignalEmbeddingCard } from '../signal-embedding-card';

const JOB_ID = 'a'.repeat(32);
const INPUT_FINGERPRINT = 'b'.repeat(64);

function status(
  overrides: {
    job?: Partial<EmbeddingStatusResponse['job']>;
    schedule?: Partial<EmbeddingStatusResponse['schedule']>;
    index?: Partial<EmbeddingStatusResponse['index']>;
    refresh_available?: boolean;
  } = {},
): EmbeddingStatusResponse {
  return {
    ok: true,
    engineVersion: '0.1.0',
    device: 'cpu',
    index: {
      active: true,
      current: true,
      fingerprint: 'graph-2026-10',
      input_fingerprint: INPUT_FINGERPRINT,
      encoder: 'e5-small',
      revision: 'r1',
      ...overrides.index,
    },
    job: {
      state: 'idle',
      id: null,
      requested: null,
      started: null,
      completed: null,
      last_success: null,
      error: null,
      ...overrides.job,
    },
    schedule: {
      enabled: false,
      interval_days: 7,
      last_check_at: null,
      next_run_at: null,
      ...overrides.schedule,
    },
    refresh_available: overrides.refresh_available ?? true,
    unavailable_reason: null,
  };
}

function renderCard(value: EmbeddingStatusResponse | null = status(), operatorConfigured = true) {
  return render(
    <SignalEmbeddingCard
      status={value}
      statusUnavailable={false}
      operatorConfigured={operatorConfigured}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.trigger.mockResolvedValue({ ok: true, message: 'Neuaufbau angefordert.' });
  h.cancel.mockResolvedValue({ ok: true, message: 'Abbruch angefordert.' });
  h.schedule.mockResolvedValue({ ok: true, message: 'Plan gespeichert.' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Signal-Embedding-Card', () => {
  it('bleibt auf Aus oder wöchentlich begrenzt und wird vom globalen Settings-Guard ignoriert', async () => {
    const { container } = renderCard();
    const select = screen.getByLabelText('Automatische Aktualisierung') as HTMLSelectElement;
    expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
      ['off', 'Aus'],
      ['weekly', 'Wöchentlich (alle 7 Tage)'],
    ]);
    const forms = [...container.querySelectorAll('form')];
    expect(forms).toHaveLength(2);
    expect(forms.every((form) => form.hasAttribute('data-settings-no-track'))).toBe(true);

    fireEvent.change(select, { target: { value: 'weekly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Plan übernehmen' }));
    await waitFor(() =>
      expect(h.schedule).toHaveBeenCalledWith({ enabled: true, intervalDays: 7 }),
    );
    expect(await screen.findByText('Plan gespeichert.')).toBeTruthy();
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it('schaltet einen abweichenden Signal-Plan nur aus, ohne ein freies Intervall anzubieten', async () => {
    renderCard(status({ schedule: { enabled: true, interval_days: 14 } }));
    const select = screen.getByLabelText('Automatische Aktualisierung') as HTMLSelectElement;
    expect(select.value).toBe('custom');
    const custom = [...select.options].find((option) => option.value === 'custom')!;
    expect([custom.textContent, custom.disabled]).toEqual(['Aktiv: alle 14 Tage', true]);
    const submit = screen.getByRole('button', { name: 'Plan übernehmen' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(select, { target: { value: 'off' } });
    fireEvent.click(submit);
    await waitFor(() => expect(h.schedule).toHaveBeenCalledWith({ enabled: false }));
  });

  it('bestätigt die Lastwarnung im Dialog, bevor der Neuaufbau startet', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Embedding jetzt aktualisieren' }));
    expect(h.trigger).not.toHaveBeenCalled();
    expect(nativeConfirm).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', { name: 'Embedding vollständig neu aufbauen?' });
    expect(dialog.textContent).toContain('CPU und Arbeitsspeicher mehrere Minuten stark auslasten');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Neuaufbau starten' }));
    await waitFor(() => expect(h.trigger).toHaveBeenCalledExactlyOnceWith({ confirmed: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Neuaufbau angefordert.')).toBeTruthy();
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it('pollt nur einen laut Signal aktiven Job und nicht nach eigener Annahme', async () => {
    vi.useFakeTimers();
    const { unmount } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Embedding jetzt aktualisieren' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Neuaufbau starten' }));
    });
    expect(h.trigger).toHaveBeenCalledOnce();
    h.refresh.mockClear();
    // Solange der Server-Status keinen aktiven Job meldet, wird nicht gepollt.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(h.refresh).not.toHaveBeenCalled();
    unmount();

    renderCard(status({ job: { state: 'running', id: JOB_ID } }));
    const busy = screen.getByRole('button', { name: 'Embedding wird aktualisiert…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_500);
    });
    expect(h.refresh).toHaveBeenCalledTimes(3);
  });

  it('pollt im Nur-Lese-Modus nicht', async () => {
    vi.useFakeTimers();
    renderCard(status({ job: { state: 'running', id: JOB_ID } }), false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('bietet für einen aktiven Job einen bestätigten Abbruch an', async () => {
    renderCard(status({ job: { state: 'running', id: JOB_ID } }));
    fireEvent.click(screen.getByRole('button', { name: 'Aktualisierung stoppen' }));
    expect(h.cancel).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Embedding-Aktualisierung stoppen?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbruch anfordern' }));
    await waitFor(() => expect(h.cancel).toHaveBeenCalledExactlyOnceWith({ jobId: JOB_ID }));
  });

  it('zeigt die eindeutige Embedding-Input-Identität getrennt vom Graphstand', () => {
    renderCard();
    const value = (label: string) => screen.getByText(label).nextElementSibling!.textContent;
    expect(value('Input-Fingerprint')).toBe(INPUT_FINGERPRINT);
    expect(value('Graph-Fingerprint')).toBe('graph-2026-10');
  });
});
