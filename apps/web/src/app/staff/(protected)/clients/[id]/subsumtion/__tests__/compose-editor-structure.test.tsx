// @vitest-environment jsdom
// Fachkatalog: RISK-AI-SUGGESTION-001 (reine Editor-Darstellung; Analyse-Action unverändert)
// Subsumtions-Editor als Render- und Verhaltenstest mit echtem Tiptap-Editor
// in jsdom (B-08, Welle 15) statt Quelltextprüfung.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEditor } from '@tiptap/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODULES } from '@/server/settings/modules';

vi.mock('../../../../admin/settings/actions', () => ({ saveModulesAction: vi.fn() }));

import { SubsumtionDocument } from '../subsumtion-document';
import { FormatToolbar } from '../editor-toolbar';
import { baseEditorExtensions } from '../editor-extensions';
import { ModulesForm } from '../../../../admin/settings/modules-form';

function ToolbarHarness({ bordered }: { bordered?: boolean }) {
  const editor = useEditor({
    extensions: baseEditorExtensions,
    content: '<p>Sachverhalt</p>',
    immediatelyRender: false,
  });
  return editor ? <FormatToolbar editor={editor} bordered={bordered} /> : null;
}

beforeEach(() => {
  // ProseMirror fragt Layoutdaten ab, die jsdom nicht berechnet.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  document.elementFromPoint ??= () => null;
});

describe('Subsumtion-Editor im Anlagemodus', () => {
  it('zeigt im Review eine feste Leiste und bietet die schwebende Leiste optional an', async () => {
    render(
      <SubsumtionDocument
        initialDoc={null}
        initialText="Der Mandant vermietet eine Wohnung."
        analyzed
        canEdit
        sourceText="Der Mandant vermietet eine Wohnung."
        totalCount={0}
        ownCount={0}
      />,
    );
    const fixed = await screen.findByRole('toolbar', { name: 'Text formatieren' });
    expect([...fixed.parentElement!.classList]).toEqual(
      expect.arrayContaining(['sticky', 'top-0', 'z-10']),
    );
    const content = document.querySelector('.tt-content')!;
    expect([...content.classList]).toEqual(
      expect.arrayContaining(['min-h-[56vh]', 'px-6', 'py-5', 'text-[15px]', 'leading-8']),
    );

    const toggle = screen.getByRole('button', { name: 'Schwebende Leiste' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    // Die feste Leiste bleibt unabhängig davon sichtbar.
    expect(screen.getByRole('toolbar', { name: 'Text formatieren' })).toBe(fixed);
  });

  it('übernimmt den Kanzlei-Standard für die schwebende Leiste und lässt Lesende ohne Leisten', async () => {
    const { unmount } = render(
      <SubsumtionDocument
        initialDoc={null}
        initialText="Text"
        analyzed
        canEdit
        floatingToolbarDefault
      />,
    );
    await screen.findByRole('toolbar', { name: 'Text formatieren' });
    expect(
      screen.getByRole('button', { name: 'Schwebende Leiste' }).getAttribute('aria-pressed'),
    ).toBe('true');
    unmount();

    render(<SubsumtionDocument initialDoc={null} initialText="Text" analyzed canEdit={false} />);
    await waitFor(() => expect(document.querySelector('.tt-content')).not.toBeNull());
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Schwebende Leiste' })).toBeNull();
  });

  it('stellt den Kanzlei-Standard in den Moduleinstellungen ein', () => {
    render(
      <ModulesForm initial={{ ...DEFAULT_MODULES, subsumtionFloatingToolbarDefault: true }} />,
    );
    const checkbox = screen.getByRole('checkbox', {
      name: 'Schwebende Formatierleiste im Subsumtions-Editor',
    }) as HTMLInputElement;
    expect(checkbox.name).toBe('subsumtionFloatingToolbarDefault');
    expect(checkbox.checked).toBe(true);
    expect(checkbox.closest('label')!.textContent).toContain(
      'Die feste Leiste bleibt immer sichtbar',
    );
  });

  it('zeichnet beide Formatleisten semantisch aus und macht Zustände hörbar', async () => {
    const { unmount } = render(<ToolbarHarness bordered={false} />);
    expect(
      await screen.findByRole('toolbar', { name: 'Schwebende Textformatierung' }),
    ).toBeTruthy();
    unmount();

    render(<ToolbarHarness />);
    const toolbar = await screen.findByRole('toolbar', { name: 'Text formatieren' });
    const bold = within(toolbar).getByRole('button', { name: 'Fett' });
    expect(bold.getAttribute('title')).toBe('Fett');
    expect(bold.getAttribute('aria-label')).toBe('Fett');
    expect(bold.getAttribute('aria-pressed')).toBe('false');
    for (const icon of toolbar.querySelectorAll('svg')) {
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
    await act(async () => {
      fireEvent.click(bold);
    });
    await waitFor(() => expect(bold.getAttribute('aria-pressed')).toBe('true'));
    // Aktionen ohne Umschaltzustand (Rückgängig) melden keinen gedrückten Zustand.
    expect(
      within(toolbar).getByRole('button', { name: 'Rückgängig' }).hasAttribute('aria-pressed'),
    ).toBe(false);
  });

  it('bewegt den Fokus mit Pfeiltasten, Pos1 und Ende zwischen aktiven Schaltflächen', async () => {
    render(<ToolbarHarness />);
    const toolbar = await screen.findByRole('toolbar', { name: 'Text formatieren' });
    const enabled = within(toolbar)
      .getAllByRole('button')
      .filter((button) => !(button as HTMLButtonElement).disabled);
    enabled[0]!.focus();
    fireEvent.keyDown(enabled[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(enabled[1]);
    fireEvent.keyDown(enabled[1]!, { key: 'End' });
    expect(document.activeElement).toBe(enabled.at(-1));
    fireEvent.keyDown(enabled.at(-1)!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(enabled[0]);
    fireEvent.keyDown(enabled[0]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(enabled.at(-1));
    fireEvent.keyDown(enabled.at(-1)!, { key: 'Home' });
    expect(document.activeElement).toBe(enabled[0]);
  });
});
