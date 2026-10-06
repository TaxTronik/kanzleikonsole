// Review-Befund K-04: Bausteine der Browser-Variante des Dokument-Explorers —
// Auswahl, Drag-Nutzlast, Such-Ziel, Download-/Upload-Helfer und die
// P-18-Verdrahtung der Sammelaktionen (eine Action je Auswahl, gesammelte
// Ablehnungen, kein Router-Refresh). Klickabläufe im Browser prüft
// apps/e2e/tests/19-document-explorer-state.spec.ts.

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry, FolderNode } from '@/components/document-browser-utils';
import type { DocumentBulkResult } from '@/server/documents/document-bulk';
import type { DocumentOps } from '../ops';
import {
  dragPayload,
  idsOfKind,
  selectedFileEntries,
  selectionKey,
  toggleSelection,
  useBrowserSelection,
  type SelectionItem,
} from '../browser-selection';
import {
  defaultDropTypeId,
  documentsDownloadUrl,
  dropUploadFormData,
  isOsFileDrag,
  splitMoveItems,
  useBrowserOperations,
  type BrowserActions,
} from '../browser-operations';
import { browserSearchTarget, currentHref } from '../browser-navigation';

const FOLDERS: FolderNode[] = [
  { id: 'a', name: 'A', parentId: null },
  { id: 'a1', name: 'A1', parentId: 'a' },
  { id: 'a1x', name: 'A1x', parentId: 'a1' },
  { id: 'b', name: 'B', parentId: null },
];

function file(id: string, overrides: Record<string, unknown> = {}): Entry {
  return {
    kind: 'file',
    id,
    title: `Datei ${id}`,
    mimeType: 'application/pdf',
    classification: 'GENERAL',
    typeName: 'Allgemein',
    typeId: null,
    tier: 'NONE',
    sizeBytes: 1,
    createdAt: '2026-09-01T10:00:00.000Z',
    folderId: null,
    deletedAt: null,
    shared: false,
    ...overrides,
  } as Entry;
}
const folder = (id: string): Entry => ({
  kind: 'folder',
  id,
  name: id,
  href: `/f/${id}`,
  icon: 'folder',
});
const nav: Entry = { kind: 'nav', id: 'clients', name: 'Mandanten', href: '/n', icon: 'client' };

describe('Auswahl', () => {
  it('schaltet Einträge um und behält die Reihenfolge', () => {
    let selection: SelectionItem[] = [];
    selection = toggleSelection(selection, 'file', 'f1');
    selection = toggleSelection(selection, 'folder', 'f1');
    selection = toggleSelection(selection, 'file', 'f2');
    expect(selection).toEqual([
      { kind: 'file', id: 'f1' },
      { kind: 'folder', id: 'f1' },
      { kind: 'file', id: 'f2' },
    ]);
    expect(toggleSelection(selection, 'file', 'f1')).toEqual([
      { kind: 'folder', id: 'f1' },
      { kind: 'file', id: 'f2' },
    ]);
    expect(idsOfKind(selection, 'file')).toEqual(['f1', 'f2']);
    expect(idsOfKind(selection, 'folder')).toEqual(['f1']);
  });

  it('zieht das Element allein oder die ganze Auswahl, wenn es dazugehört', () => {
    const selection: SelectionItem[] = [
      { kind: 'file', id: 'f1' },
      { kind: 'folder', id: 'a' },
    ];
    const selected = new Set(selection.map(selectionKey));
    expect(dragPayload(selection, selected, file('f1'))).toBe(selection);
    expect(dragPayload(selection, selected, file('f9'))).toEqual([{ kind: 'file', id: 'f9' }]);
    expect(dragPayload([], new Set(), folder('a'))).toEqual([{ kind: 'folder', id: 'a' }]);
    expect(dragPayload(selection, selected, nav)).toEqual([]);
  });

  it('liefert die ausgewählten Dateien in Listenreihenfolge, ohne Ordner', () => {
    const entries = [file('f2'), folder('f1'), file('f1'), file('f3')];
    const selected = new Set(['file:f1', 'file:f2', 'folder:f1']);
    expect(selectedFileEntries(entries, selected).map((entry) => entry.id)).toEqual(['f2', 'f1']);
  });

  it('beginnt leer und meldet „nur Dateien“ auch für die leere Auswahl', () => {
    let state: ReturnType<typeof useBrowserSelection> | undefined;
    function Probe() {
      state = useBrowserSelection([file('f1')]);
      return null;
    }
    renderToStaticMarkup(<Probe />);
    expect(state?.selection).toEqual([]);
    expect(state?.onlyFiles).toBe(true);
    expect(state?.isSelected('file', 'f1')).toBe(false);
    expect(state?.selectedFiles()).toEqual([]);
  });
});

describe('Such-Ziel und Downloads', () => {
  it('sucht in der aktuellen Ebene und entfernt einen leeren Begriff', () => {
    const origin = 'https://kanzlei.example';
    expect(currentHref([])).toBe('/staff/documents');
    expect(
      currentHref([
        { label: 'A', href: '/a' },
        { label: 'B', href: '/staff/documents?folder=b' },
      ]),
    ).toBe('/staff/documents?folder=b');
    expect(browserSearchTarget('/staff/documents?folder=b&q=alt', '  Beleg  ', origin)).toBe(
      '/staff/documents?folder=b&q=Beleg',
    );
    expect(browserSearchTarget('/staff/documents?folder=b&q=alt', '   ', origin)).toBe(
      '/staff/documents?folder=b',
    );
  });

  it('baut das Download-Ziel aus Dateien und Ordnern', () => {
    expect(documentsDownloadUrl(['f1', 'f2'], [])).toBe(
      '/api/staff/documents/download?ids=f1%2Cf2',
    );
    expect(documentsDownloadUrl([], ['a'])).toBe('/api/staff/documents/download?folders=a');
    expect(documentsDownloadUrl(['f1'], ['a'])).toBe(
      '/api/staff/documents/download?ids=f1&folders=a',
    );
  });

  it('wählt für Datei-Drops GENERAL, sonst den ersten Typ ohne Schutzstufe, sonst den ersten', () => {
    const gobd = { id: 'gobd', classificationKey: 'GOBD_INVOICE', tier: 'GOBD' };
    const none = { id: 'none', classificationKey: null, tier: 'NONE' };
    const general = { id: 'general', classificationKey: 'GENERAL', tier: 'NONE' };
    expect(defaultDropTypeId([gobd, none, general])).toBe('general');
    expect(defaultDropTypeId([gobd, none])).toBe('none');
    expect(defaultDropTypeId([gobd])).toBe('gobd');
    expect(defaultDropTypeId([])).toBe('');
  });

  it('lädt Drops ohne Endung im Titel und mit Ersatz-MIME-Typ in Bereich und Ordner', () => {
    const data = dropUploadFormData(
      new File(['x'], 'Beleg.2026.pdf'),
      'type-1',
      'client-1',
      'folder-1',
    );
    expect(Object.fromEntries([...data.entries()].filter(([key]) => key !== 'file'))).toEqual({
      documentTypeId: 'type-1',
      title: 'Beleg.2026',
      mimeType: 'application/octet-stream',
      clientId: 'client-1',
      folderId: 'folder-1',
    });
    const internal = dropUploadFormData(
      new File(['x'], 'a.pdf', { type: 'application/pdf' }),
      't',
      null,
      null,
    );
    expect(internal.get('mimeType')).toBe('application/pdf');
    expect(internal.has('clientId')).toBe(false);
    expect(internal.has('folderId')).toBe(false);
  });

  it('erkennt Datei-Drags aus dem Betriebssystem', () => {
    expect(isOsFileDrag({ types: ['Files', 'text/uri-list'] } as unknown as DataTransfer)).toBe(
      true,
    );
    expect(isOsFileDrag({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false);
  });
});

describe('Verschieben: Teilbaum-Sperre', () => {
  it('sperrt Ordner, deren Ziel in ihrem eigenen Teilbaum liegt', () => {
    const items: SelectionItem[] = [
      { kind: 'folder', id: 'a' },
      { kind: 'folder', id: 'b' },
      { kind: 'file', id: 'f1' },
    ];
    expect(splitMoveItems(items, 'a1x', FOLDERS)).toEqual({
      movable: [
        { kind: 'folder', id: 'b' },
        { kind: 'file', id: 'f1' },
      ],
      blocked: [{ id: 'a', error: 'Ordner kann nicht in seinen eigenen Unterbaum.' }],
    });
    // Wurzel ist für jeden Ordner ein zulässiges Ziel; der Ordner selbst nicht.
    expect(splitMoveItems(items, null, FOLDERS).blocked).toEqual([]);
    expect(splitMoveItems([{ kind: 'folder', id: 'b' }], 'b', FOLDERS).movable).toEqual([]);
  });
});

function bulkResult(overrides: Partial<DocumentBulkResult> = {}): DocumentBulkResult {
  return { ok: true, done: 0, rejected: [], ...overrides };
}

function fakeOps() {
  const transitions: Array<Promise<unknown>> = [];
  const ops = {
    router: { refresh: vi.fn(), push: vi.fn() },
    start: vi.fn((callback: () => unknown) => {
      transitions.push(Promise.resolve(callback()));
    }),
    setOpError: vi.fn(),
    setConfirmState: vi.fn(),
  };
  return { ops, settle: () => Promise.all(transitions) };
}

function probeOperations(options: {
  actions?: Partial<BrowserActions>;
  scope?: { clientId: string | null; typeParam: string } | null;
  deleted?: boolean;
}) {
  const { ops, settle } = fakeOps();
  const actions: BrowserActions = {
    moveItems: vi.fn(async () => bulkResult()),
    setShare: vi.fn(async () => bulkResult()),
    deleteFolder: vi.fn(async () => ({ ok: true })),
    ...options.actions,
  };
  const onMoved = vi.fn();
  const onShared = vi.fn();
  let operations: ReturnType<typeof useBrowserOperations> | undefined;
  function Probe() {
    operations = useBrowserOperations({
      ops: ops as unknown as DocumentOps,
      actions,
      folders: FOLDERS,
      scope:
        options.scope === undefined
          ? { clientId: 'client-1', typeParam: 'business' }
          : options.scope,
      deleted: options.deleted ?? false,
      currentFolderId: 'b',
      onMoved,
      onShared,
    });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return { operations: operations!, ops, actions, onMoved, onShared, settle };
}

describe('Sammelaktionen (P-18)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('verschiebt die ganze Auswahl mit EINER Action und schließt danach ab', async () => {
    const { operations, actions, ops, onMoved, settle } = probeOperations({});

    operations.moveSet(
      [
        { kind: 'file', id: 'f1' },
        { kind: 'folder', id: 'a' },
        { kind: 'file', id: 'f2' },
      ],
      'b',
    );
    await settle();

    expect(actions.moveItems).toHaveBeenCalledTimes(1);
    expect(actions.moveItems).toHaveBeenCalledWith({
      documentIds: ['f1', 'f2'],
      folderIds: ['a'],
      targetFolderId: 'b',
    });
    expect(ops.setOpError).toHaveBeenCalledTimes(1);
    expect(ops.setOpError).toHaveBeenCalledWith(null);
    expect(onMoved).toHaveBeenCalledTimes(1);
    expect(ops.router.refresh).not.toHaveBeenCalled();
  });

  it('meldet gesperrte und abgelehnte Einträge gesammelt', async () => {
    const { operations, actions, ops, settle } = probeOperations({
      actions: {
        moveItems: vi.fn(async () =>
          bulkResult({ ok: false, done: 1, rejected: [{ id: 'f2', error: 'Kein Zugriff.' }] }),
        ),
      },
    });

    operations.moveSet(
      [
        { kind: 'folder', id: 'a' },
        { kind: 'file', id: 'f1' },
        { kind: 'file', id: 'f2' },
      ],
      'a1',
    );
    await settle();

    expect(actions.moveItems).toHaveBeenCalledWith({
      documentIds: ['f1', 'f2'],
      folderIds: [],
      targetFolderId: 'a1',
    });
    expect(ops.setOpError).toHaveBeenLastCalledWith(
      '1 verschoben, 2 abgelehnt:\nOrdner kann nicht in seinen eigenen Unterbaum.\nKein Zugriff.',
    );
  });

  it('ruft keine Action, wenn nur gesperrte Ordner übrig bleiben', async () => {
    const { operations, actions, ops, onMoved, settle } = probeOperations({});

    operations.moveSet([{ kind: 'folder', id: 'a' }], 'a1x');
    await settle();

    expect(actions.moveItems).not.toHaveBeenCalled();
    expect(ops.setOpError).toHaveBeenLastCalledWith(
      'Ordner kann nicht in seinen eigenen Unterbaum.',
    );
    expect(onMoved).toHaveBeenCalledTimes(1);
    operations.moveSet([], 'b');
    expect(ops.start).toHaveBeenCalledTimes(1);
  });

  it('übernimmt Drag-Nutzlasten ohne den Zielordner selbst und ignoriert fremde Daten', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { operations, actions, settle } = probeOperations({});

    operations.dropInto(
      'b',
      JSON.stringify([
        { kind: 'folder', id: 'b' },
        { kind: 'file', id: 'f1' },
      ]),
    );
    operations.dropInto(null, 'kein JSON');
    await settle();

    expect(actions.moveItems).toHaveBeenCalledTimes(1);
    expect(actions.moveItems).toHaveBeenCalledWith({
      documentIds: ['f1'],
      folderIds: [],
      targetFolderId: 'b',
    });
    expect(warn).toHaveBeenCalledWith(
      '[doc-explorer] Drag-Drop-Payload konnte nicht geparst werden',
    );
    warn.mockRestore();
  });

  it('gibt eine Auswahl mit EINER Action frei oder setzt sie privat', async () => {
    const { operations, actions, ops, onShared, settle } = probeOperations({
      actions: {
        setShare: vi.fn(async ({ documentIds }: { documentIds: string[] }) =>
          bulkResult({
            ok: false,
            done: documentIds.length - 1,
            rejected: [{ id: 'f2', error: 'Lohnunterlagen werden nicht geteilt.' }],
          }),
        ),
      },
    });

    operations.bulkShare(['f1', 'f2', 'f3'], false);
    operations.bulkShare([], true);
    await settle();

    expect(actions.setShare).toHaveBeenCalledTimes(1);
    expect(actions.setShare).toHaveBeenCalledWith({
      documentIds: ['f1', 'f2', 'f3'],
      share: false,
    });
    expect(ops.setOpError).toHaveBeenLastCalledWith(
      '2 auf privat gesetzt, 1 abgelehnt:\nLohnunterlagen werden nicht geteilt.',
    );
    expect(onShared).toHaveBeenCalledTimes(1);
  });

  it('löscht Ordner erst nach Bestätigung', async () => {
    const { operations, actions, ops } = probeOperations({});

    operations.deleteFolder('a', 'Belege');

    expect(actions.deleteFolder).not.toHaveBeenCalled();
    const confirm = ops.setConfirmState.mock.calls[0]![0];
    expect(confirm).toMatchObject({
      title: 'Ordner löschen',
      message:
        'Ordner „Belege" löschen?\nInhalt rückt eine Ebene hoch. Kein Dokument wird gelöscht.',
      confirmLabel: 'Löschen',
      busyLabel: 'Löscht…',
      danger: true,
    });
    await confirm.action();
    expect(actions.deleteFolder).toHaveBeenCalledWith({ folderId: 'a' });
  });

  it('lädt Datei-Drops einzeln hoch, sammelt Fehler und lädt die Liste neu', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/staff/document-types') {
        return Response.json({
          types: [{ id: 'type-1', classificationKey: 'GENERAL', tier: 'NONE' }],
        });
      }
      const title = (init?.body as FormData).get('title');
      return title === 'kaputt'
        ? Response.json({ error: 'Virus gefunden' }, { status: 422 })
        : Response.json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const { operations, ops, settle } = probeOperations({});

    operations.uploadDropped([new File(['a'], 'gut.pdf'), new File(['b'], 'kaputt.pdf')]);
    await vi.waitFor(() => expect(ops.start).toHaveBeenCalledTimes(1));
    await settle();
    await vi.waitFor(() => expect(ops.router.refresh).toHaveBeenCalledTimes(1));

    const commits = fetchMock.mock.calls.filter(([url]) => url === '/api/staff/documents/commit');
    expect(commits).toHaveLength(2);
    expect((commits[0]![1]!.body as FormData).get('folderId')).toBe('b');
    expect(ops.setOpError).toHaveBeenLastCalledWith('Upload-Fehler:\nkaputt.pdf: Virus gefunden');
  });

  it('lädt ohne Bereich, im Gelöscht-Modus oder ohne Datei-Typ nichts hoch', async () => {
    const fetchMock = vi.fn(async () => Response.json({ types: [] }));
    vi.stubGlobal('fetch', fetchMock);

    probeOperations({ scope: null }).operations.uploadDropped([new File(['a'], 'a.pdf')]);
    probeOperations({ deleted: true }).operations.uploadDropped([new File(['a'], 'a.pdf')]);
    expect(fetchMock).not.toHaveBeenCalled();

    const { operations, ops } = probeOperations({});
    operations.uploadDropped([new File(['a'], 'a.pdf')]);
    await vi.waitFor(() =>
      expect(ops.setOpError).toHaveBeenCalledWith('Kein Datei-Typ verfügbar.'),
    );
    expect(ops.start).not.toHaveBeenCalled();
  });
});
