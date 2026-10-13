// @vitest-environment jsdom
// Fachkatalog: RISK-ARCHIVE-SNAPSHOT-001
//
// Subsumtions-Dokument: Schreib- und Leisten-Bedingungen der Editoroberfläche
// mit echtem Tiptap-Editor in jsdom (B-08, Welle 15); ersetzt die
// Quelltextprüfung aus presentation-extraction.test.ts. Archivierte Analysen
// (canEdit=false) speichern keine Formatierung, zeigen keine Leisten und
// verwerfen ausstehende Formatänderungen.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SubsumtionDocument } from '../subsumtion-document';
import type { MarkingDTO } from '../_ui';

const TEXT = 'Der Mandant vermietet eine Wohnung.';

function marking(id: string, start: number, end: number): MarkingDTO {
  return {
    id,
    start,
    end,
    matchedText: TEXT.slice(start, end),
    herkunft: 'WOERTLICH',
    status: 'OFFEN',
    begriff: `Begriff ${id}`,
    farbe: null,
    label: null,
    streitig: false,
  } as unknown as MarkingDTO;
}

async function editorInstance(): Promise<Editor> {
  await waitFor(() => expect(document.querySelector('.ProseMirror')).not.toBeNull());
  return (document.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor;
}

beforeEach(() => {
  // ProseMirror fragt Layoutdaten ab, die jsdom nicht berechnet.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  document.elementFromPoint ??= () => null;
});

describe('RISK-ARCHIVE-SNAPSHOT-001: Editoroberfläche übernimmt Schreib- und Leistenbedingungen', () => {
  it('speichert reine Formatänderungen, aber nicht bei geändertem Text', async () => {
    const onSaveFormat = vi.fn(async (_doc: unknown) => ({ ok: true }));
    render(
      <SubsumtionDocument
        initialDoc={null}
        initialText={TEXT}
        analyzed
        canEdit
        sourceText={TEXT}
        onSaveFormat={onSaveFormat}
      />,
    );
    const editor = await editorInstance();

    await act(async () => {
      editor.chain().selectAll().toggleBold().run();
    });
    // Verlassen des Editors speichert sofort statt nach dem Debounce.
    await act(async () => {
      fireEvent.blur(editor.view.dom);
    });
    expect(onSaveFormat).toHaveBeenCalledOnce();
    expect(JSON.stringify(onSaveFormat.mock.calls[0]![0])).toContain('"bold"');

    await act(async () => {
      editor.chain().setTextSelection(1).insertContent('Neu ').run();
    });
    await act(async () => {
      fireEvent.blur(editor.view.dom);
    });
    expect(onSaveFormat).toHaveBeenCalledOnce();
  });

  it('speichert in archivierten Analysen nichts und verwirft beim Sperren Ausstehendes', async () => {
    const onSaveFormat = vi.fn(async (_doc: unknown) => ({ ok: true }));
    const props = {
      initialDoc: null,
      initialText: TEXT,
      analyzed: true,
      sourceText: TEXT,
      onSaveFormat,
    };
    const { unmount } = render(<SubsumtionDocument {...props} canEdit={false} />);
    let editor = await editorInstance();
    expect(editor.isEditable).toBe(false);
    await act(async () => {
      editor.chain().selectAll().toggleBold().run();
    });
    await act(async () => {
      fireEvent.blur(editor.view.dom);
    });
    expect(onSaveFormat).not.toHaveBeenCalled();
    unmount();

    // Ausstehende Formatierung, dann Archivierung (canEdit wechselt auf false).
    const view = render(<SubsumtionDocument {...props} canEdit />);
    editor = await editorInstance();
    await act(async () => {
      editor.chain().selectAll().toggleItalic().run();
    });
    view.rerender(<SubsumtionDocument {...props} canEdit={false} />);
    await act(async () => {
      fireEvent.blur(editor.view.dom);
    });
    expect(onSaveFormat).not.toHaveBeenCalled();
    view.unmount();
    expect(onSaveFormat).not.toHaveBeenCalled();
  });

  it('bietet das Zusammenführen von Absätzen nur im bearbeitbaren Anlagemodus an', async () => {
    const compose = render(
      <SubsumtionDocument initialDoc={null} initialText={TEXT} analyzed={false} canEdit />,
    );
    await screen.findByRole('toolbar', { name: 'Text formatieren' });
    expect(screen.getByRole('button', { name: 'Absätze zusammenführen' })).toBeTruthy();
    compose.unmount();

    const review = render(
      <SubsumtionDocument
        initialDoc={null}
        initialText={TEXT}
        analyzed
        canEdit
        sourceText={TEXT}
      />,
    );
    await screen.findByRole('toolbar', { name: 'Text formatieren' });
    expect(screen.queryByRole('button', { name: 'Absätze zusammenführen' })).toBeNull();
    review.unmount();

    render(
      <SubsumtionDocument initialDoc={null} initialText={TEXT} analyzed={false} canEdit={false} />,
    );
    await editorInstance();
    expect(screen.queryByRole('button', { name: 'Absätze zusammenführen' })).toBeNull();
  });

  it('zeigt die schwebende Leiste und die Markierungsauswahl nur bearbeitbar und eingeschaltet', async () => {
    const onSelectionForMarking = vi.fn();
    const enabled = render(
      <SubsumtionDocument
        initialDoc={null}
        initialText={TEXT}
        analyzed
        canEdit
        sourceText={TEXT}
        floatingToolbarDefault
        onSelectionForMarking={onSelectionForMarking}
      />,
    );
    let editor = await editorInstance();
    await act(async () => {
      editor.commands.setTextSelection({ from: 5, to: 12 });
    });
    expect(
      await screen.findByRole('toolbar', { name: 'Schwebende Textformatierung' }),
    ).toBeTruthy();
    expect(onSelectionForMarking).toHaveBeenLastCalledWith({ start: 4, end: 11, text: 'Mandant' });

    // Ausschalten blendet die offene Leiste sofort aus, auch bei neuer Auswahl.
    fireEvent.click(screen.getByRole('button', { name: 'Schwebende Leiste' }));
    expect(screen.queryByRole('toolbar', { name: 'Schwebende Textformatierung' })).toBeNull();
    await act(async () => {
      editor.commands.setTextSelection({ from: 13, to: 22 });
    });
    expect(screen.queryByRole('toolbar', { name: 'Schwebende Textformatierung' })).toBeNull();
    enabled.unmount();

    // Archiviert: weder Leiste noch eine neue manuelle Markierung aus der Auswahl.
    onSelectionForMarking.mockClear();
    render(
      <SubsumtionDocument
        initialDoc={null}
        initialText={TEXT}
        analyzed
        canEdit={false}
        sourceText={TEXT}
        floatingToolbarDefault
        onSelectionForMarking={onSelectionForMarking}
      />,
    );
    editor = await editorInstance();
    await act(async () => {
      editor.commands.setTextSelection({ from: 5, to: 12 });
    });
    expect(screen.queryByRole('toolbar', { name: 'Schwebende Textformatierung' })).toBeNull();
    expect(onSelectionForMarking.mock.calls.every(([selection]) => selection === null)).toBe(true);
  });

  it('wählt die kleinste überdeckende Markierung mit dem aktuellen Callback', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const markings = [marking('wide', 4, 34), marking('narrow', 4, 11)];
    const props = {
      initialDoc: null,
      initialText: TEXT,
      analyzed: true,
      canEdit: true,
      sourceText: TEXT,
      visibleMarkings: markings,
    };
    const { rerender } = render(<SubsumtionDocument {...props} onSelectMarking={first} />);
    const editor = await editorInstance();
    await act(async () => {
      editor.commands.setTextSelection(7);
    });
    expect(first).toHaveBeenLastCalledWith('narrow');

    // Neuer Callback nach dem Commit: Editor-Ereignisse nutzen ihn sofort.
    rerender(<SubsumtionDocument {...props} onSelectMarking={second} />);
    first.mockClear();
    await act(async () => {
      editor.commands.setTextSelection(20);
    });
    expect(second).toHaveBeenLastCalledWith('wide');
    expect(first).not.toHaveBeenCalled();
  });

  it('skaliert die Schrift der Lesefläche mit dem Zoom und setzt sie zurück', async () => {
    render(
      <SubsumtionDocument
        initialDoc={null}
        initialText={TEXT}
        analyzed
        canEdit
        sourceText={TEXT}
      />,
    );
    const editor = await editorInstance();
    const dom = editor.view.dom as HTMLElement;
    expect(dom.style.getPropertyValue('font-size')).toBe('');

    fireEvent.click(screen.getByTitle('Vergrößern'));
    // jsdom (cssstyle) rechnet calc() vor, Browser behalten den Ausdruck.
    expect(dom.style.getPropertyValue('font-size')).toMatch(
      /^calc\((0\.875rem \* 1\.15|1\.00625rem)\)$/,
    );
    expect(dom.style.getPropertyValue('--tt-zoom')).toBe('1.15');

    fireEvent.click(screen.getByTitle('Zoom zurücksetzen'));
    expect(dom.style.getPropertyValue('font-size')).toBe('');
    expect(dom.style.getPropertyValue('--tt-zoom')).toBe('');
  });
});
