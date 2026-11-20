// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FolderTreePicker } from '../folder-tree-picker';
import { MoveTargetDialog, RetagDialog } from '../document-dialogs';

vi.mock('@/app/staff/(protected)/documents/folder-actions', () => ({}));
vi.mock('@/app/staff/(protected)/documents/actions', () => ({}));
afterEach(() => vi.unstubAllGlobals());

const folders = [
  { id: 'a', name: 'Akte', parentId: null },
  { id: 'b', name: 'Belege', parentId: 'a' },
  { id: 'c', name: 'Korrespondenz', parentId: null },
];

it('zeigt den aktuellen Unterordner an und benennt die aufklappbare Ordnerzeile', () => {
  const onSelect = vi.fn();
  render(<FolderTreePicker folders={folders} value="b" onSelect={onSelect} rootLabel="Wurzel" />);
  expect(screen.getByRole('button', { name: 'Belege', pressed: true })).toBeTruthy();
  const toggle = screen.getByRole('button', { name: /Akte.*zuklappen/i, expanded: true });
  fireEvent.click(toggle);
  expect(screen.queryByRole('button', { name: 'Belege' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Akte.*aufklappen/i, expanded: false }));
  expect(screen.getByRole('button', { name: 'Belege', pressed: true })).toBeTruthy();
  const root = screen.getByRole('button', { name: 'Wurzel' });
  expect(root.tagName).toBe('BUTTON');
  fireEvent.click(root);
  expect(onSelect).toHaveBeenCalledWith(null);
});

it('lässt einen laufenden Sammelauftrag weder erneut starten noch durch Escape schließen', () => {
  const onClose = vi.fn();
  const onPick = vi.fn();
  render(
    <MoveTargetDialog
      folders={folders}
      movingFolderIds={[]}
      onClose={onClose}
      onPick={onPick}
      busy
    />,
  );
  const confirm = screen.getByRole('button', { name: /verschieb/i });
  expect(confirm.matches(':disabled')).toBe(true);
  fireEvent.click(confirm);
  fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  expect(onPick).not.toHaveBeenCalled();
});

it('beendet bei einem Ladefehler die Warteanzeige und lädt die Typauswahl erneut', async () => {
  const fetchTypes = vi
    .fn()
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ types: [] }) });
  vi.stubGlobal('fetch', fetchTypes);
  render(
    <RetagDialog documentIds={['d1']} documentTitle="Brief" onClose={vi.fn()} onDone={vi.fn()} />,
  );
  expect((await screen.findByRole('alert')).textContent).toContain('Datei-Typen');
  fireEvent.click(screen.getByRole('button', { name: 'Erneut laden' }));
  expect(await screen.findByText('Keine Datei-Typen verfügbar.')).toBeTruthy();
  expect(screen.queryByText('Lädt Typen…')).toBeNull();
  expect(fetchTypes).toHaveBeenCalledTimes(2);
});
