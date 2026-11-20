// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { readXlsx } from '@/lib/xlsx/read-xlsx';
import { formatXlsxCell } from '@/lib/xlsx/format-cell';
import { OfficeViewer } from '../office-viewer';

vi.mock('@/lib/xlsx/read-xlsx', () => ({ readXlsx: vi.fn() }));
vi.mock('@/lib/xlsx/format-cell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/xlsx/format-cell')>();
  return { ...actual, formatXlsxCell: vi.fn(actual.formatXlsxCell) };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('formatiert nur sichtbare Zellen des geöffneten Arbeitsblatts', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array())),
  );
  vi.mocked(readXlsx).mockReturnValue([
    { name: 'Übersicht', rows: [Array.from({ length: 101 }, (_, i) => i), ['Eintrag']] },
    { name: 'Details', rows: [['Spalte'], ['Weiteres Blatt']] },
  ]);
  render(<OfficeViewer url="/mappe.xlsx" />);
  await screen.findByText('Eintrag');
  expect(screen.getByText(/100 von 101 Spalten/)).toBeTruthy();
  const formatted = vi.mocked(formatXlsxCell).mock.calls.map(([value]) => value);
  expect(formatted).not.toContain(100);
  expect(formatted).not.toContain('Weiteres Blatt');
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(await screen.findByText('Weiteres Blatt')).toBeTruthy();
});

it('bricht den ausstehenden Download beim Schließen der Vorschau ab', () => {
  const fetch = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetch);
  const view = render(<OfficeViewer url="/mappe.xlsx" />);
  const signal = fetch.mock.calls[0]?.[1]?.signal;
  expect(signal?.aborted).toBe(false);
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
