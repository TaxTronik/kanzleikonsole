// @vitest-environment jsdom
// ACP-Mandantenlayout: Speicherweg, Reihenfolge der Speicherungen, Fokus und
// Live-Rückmeldung als Verhaltenstest (B-08, Welle 15). Ersetzt die
// Quelltextprüfung aus client-layout-a11y.test.tsx.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientLayoutConfig } from '@/server/settings/client-layout-shared';

const h = vi.hoisted(() => ({
  save: vi.fn(),
  reset: vi.fn(),
  refresh: vi.fn(),
  confirm: vi.fn(),
  controls: null as null | { onRemove: (id: string) => void },
  editCssLoaded: false,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('../actions', () => ({
  saveClientLayoutAction: h.save,
  resetClientLayoutAction: h.reset,
}));
vi.mock('@/components/ui/modal', () => ({ confirmDialog: h.confirm }));
vi.mock('@/components/ui/grid-layout-edit.css', () => {
  h.editCssLoaded = true;
  return {};
});
// Echte Bedienelemente; die Props werden nur mitgeschnitten, um den Schutz
// gegen das Entfernen des letzten Blocks auch ohne (gesperrten) Button zu prüfen.
vi.mock('@/components/ui/grid-layout-controls', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/components/ui/grid-layout-controls')>();
  return {
    GridLayoutControls: (
      props: ComponentProps<typeof original.GridLayoutControls>,
    ): ReturnType<typeof original.GridLayoutControls> => {
      h.controls = props;
      return original.GridLayoutControls(props);
    },
  };
});

import { AccessibleDisplayProvider } from '@/components/accessible-display';
import { ClientLayoutForm } from '../client-layout-form';

// Nebeneinander, damit das Schließen freier Lücken (Kompaktierung) die
// erwarteten Positionen nicht verschiebt.
const TWO_BLOCKS: ClientLayoutConfig = {
  items: [
    { id: 'contacts', x: 0, y: 0, w: 6, h: 6 },
    { id: 'master_data', x: 6, y: 0, w: 6, h: 8 },
  ],
} as ClientLayoutConfig;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function setup(initial: ClientLayoutConfig = TWO_BLOCKS) {
  render(<ClientLayoutForm initial={initial} />);
  const edit = screen.getByRole('button', { name: 'Anpassen' });
  fireEvent.click(edit);
  return { edit };
}

function applyGeometry(
  id: 'contacts' | 'master_data',
  name: string,
  geometry: Partial<
    Record<'Startspalte' | 'Startzeile' | 'Breite (Spalten)' | 'Höhe (Rasterzeilen)', number>
  >,
) {
  fireEvent.change(screen.getByLabelText('Block anpassen'), { target: { value: id } });
  const form = screen.getByRole('form', { name: `${name}: Position und Größe` });
  for (const [label, value] of Object.entries(geometry)) {
    fireEvent.change(within(form).getByLabelText(label), { target: { value: String(value) } });
  }
  fireEvent.submit(form);
}

async function flushSave(ms = 600) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  h.save.mockResolvedValue({ ok: true });
  h.confirm.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ACP-Mandantenlayout: Speichern und Rückmeldung', () => {
  it('übernimmt Position und Größe über den vorhandenen Speicherweg und meldet den Stand live', async () => {
    setup();
    applyGeometry('contacts', 'Ansprechpartner', { Startzeile: 1, 'Höhe (Rasterzeilen)': 4 });
    const status = screen.getByRole('status');
    expect(status.textContent).toBe(
      'Ansprechpartner: Spalte 1, Zeile 1, Breite 6, Höhe 4. Änderungen werden gespeichert …',
    );
    expect(h.save).not.toHaveBeenCalled();

    await flushSave();
    expect(h.save).toHaveBeenCalledExactlyOnceWith({
      items: [
        { id: 'contacts', x: 0, y: 0, w: 6, h: 4 },
        { id: 'master_data', x: 6, y: 0, w: 6, h: 8 },
      ],
    });
    expect(status.textContent).toBe(
      'Ansprechpartner: Spalte 1, Zeile 1, Breite 6, Höhe 4. Layout gespeichert.',
    );
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it('meldet unzulässige Geometrie als Fehler, ohne zu speichern', async () => {
    setup();
    applyGeometry('contacts', 'Ansprechpartner', { 'Breite (Spalten)': 5 });
    expect(screen.getByRole('alert').textContent).not.toBe('');
    await flushSave();
    expect(h.save).not.toHaveBeenCalled();
  });

  it('speichert nacheinander und zeigt nur das Ergebnis der neuesten Änderung', async () => {
    const first = deferred<{ ok: boolean; error?: string }>();
    h.save.mockReturnValueOnce(first.promise);
    setup();

    applyGeometry('contacts', 'Ansprechpartner', { 'Höhe (Rasterzeilen)': 5 });
    await flushSave();
    expect(h.save).toHaveBeenCalledTimes(1);

    applyGeometry('master_data', 'Stammdaten', { 'Höhe (Rasterzeilen)': 9 });
    await flushSave();
    // Die zweite Speicherung wartet auf die erste.
    expect(h.save).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve({ ok: false, error: 'veraltet' }));
    expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.save.mock.calls[1]![0]).toEqual({
      items: [
        { id: 'contacts', x: 0, y: 0, w: 6, h: 5 },
        { id: 'master_data', x: 6, y: 0, w: 6, h: 9 },
      ],
    });
    // Die überholte Antwort erzeugt keine Fehlermeldung.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(
      'Stammdaten: Spalte 7, Zeile 1, Breite 6, Höhe 9. Layout gespeichert.',
    );
  });

  it('meldet Speicherfehler als Alarm', async () => {
    setup();
    h.save.mockRejectedValueOnce(new Error('offline'));
    applyGeometry('contacts', 'Ansprechpartner', { 'Höhe (Rasterzeilen)': 5 });
    await flushSave();
    expect(screen.getByRole('alert').textContent).toBe(
      'Layout konnte nicht gespeichert werden. Bitte die Änderung erneut übernehmen.',
    );
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('setzt erst nach laufenden Speicherungen auf Standard zurück', async () => {
    const pending = deferred<{ ok: boolean }>();
    h.save.mockReturnValueOnce(pending.promise);
    h.reset.mockResolvedValue({ ok: false, error: 'Zurücksetzen abgelehnt.' });
    setup();
    applyGeometry('contacts', 'Ansprechpartner', { 'Höhe (Rasterzeilen)': 5 });
    await flushSave();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Standard' }));
    });
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.reset).not.toHaveBeenCalled();

    await act(async () => pending.resolve({ ok: true }));
    expect(h.reset).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert').textContent).toBe('Zurücksetzen abgelehnt.');
  });
});

describe('ACP-Mandantenlayout: Entfernen und Fokus', () => {
  it('führt den Fokus nach dem Entfernen auf den Bearbeiten-Schalter zurück', async () => {
    const { edit } = setup();
    expect(edit.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Block entfernen: Ansprechpartner' }));
    expect(document.activeElement).toBe(edit);
    expect(screen.getByRole('status').textContent).toBe(
      'Block entfernt. Änderungen werden gespeichert …',
    );
    await flushSave();
    expect(h.save).toHaveBeenCalledExactlyOnceWith({
      items: [{ id: 'master_data', x: 6, y: 0, w: 6, h: 8 }],
    });
  });

  it('lässt den letzten Block nicht entfernen', async () => {
    setup({ items: [{ id: 'contacts', x: 0, y: 0, w: 12, h: 6 }] } as ClientLayoutConfig);
    const remove = screen.getByRole('button', {
      name: 'Block entfernen: Ansprechpartner',
    }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    // Auch ein direkter Aufruf (z. B. aus einer veralteten Ansicht) bleibt wirkungslos.
    act(() => h.controls!.onRemove('contacts'));
    expect(screen.getByRole('alert').textContent).toBe(
      'Mindestens ein Block muss erhalten bleiben.',
    );
    await flushSave();
    expect(h.save).not.toHaveBeenCalled();
  });

  it('lädt das gemeinsame Editor-Stylesheet der Rasterbearbeitung', () => {
    // Der Mock greift nur, wenn client-layout-form.tsx das Stylesheet importiert.
    expect(h.editCssLoaded).toBe(true);
  });

  it('hängt nicht vom barrierearmen Anzeigemodus ab', () => {
    const markup = (enabled: boolean) => {
      const { container, unmount } = render(
        <AccessibleDisplayProvider initialEnabled={enabled} saveAction={async () => ({ ok: true })}>
          <ClientLayoutForm initial={TWO_BLOCKS} />
        </AccessibleDisplayProvider>,
      );
      const html = container.querySelector('.min-w-0.space-y-3')!.outerHTML;
      unmount();
      return html;
    };
    expect(markup(true)).toBe(markup(false));
  });
});
