import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workspaceSource = readFileSync(
  new URL('../subsumtion-workspace.tsx', import.meta.url),
  'utf8',
);
const documentSource = readFileSync(new URL('../subsumtion-document.tsx', import.meta.url), 'utf8');
const newPageSource = readFileSync(new URL('../new/page.tsx', import.meta.url), 'utf8');
const modulesFormSource = readFileSync(
  new URL('../../../../admin/settings/modules-form.tsx', import.meta.url),
  'utf8',
);
const toolbarSource = readFileSync(new URL('../editor-toolbar.tsx', import.meta.url), 'utf8');

// Fachkatalog: RISK-AI-SUGGESTION-001 (reine Editor-Darstellung; Analyse-Action unverändert)
describe('Subsumtion-Editor im Anlagemodus', () => {
  it('nutzt die große, zusammenhängende Arbeitsfläche der Wissensdatenbank', () => {
    expect(newPageSource).toContain('p-4 sm:p-6 lg:p-8');
    expect(newPageSource).not.toContain('max-w-[1600px]');
    expect(workspaceSource).toContain('<section className="card overflow-hidden">');
    expect(workspaceSource).toContain('id="subsumtion-title"');
    expect(workspaceSource).toContain('className="input text-lg font-semibold"');
    expect(documentSource).toContain("'min-h-[64vh] p-8 text-[15px] leading-7'");
    expect(documentSource).toContain('<FormatToolbar editor={editor}');
    expect(workspaceSource).toContain('Aus Dokument importieren');
    expect(workspaceSource).toContain('{text.length} Zeichen');
    expect(workspaceSource).toContain('Analysieren');
  });

  it('zeigt im Review eine feste Leiste und bietet die schwebende Leiste optional an', () => {
    expect(documentSource).toContain('sticky top-0 z-10');
    expect(documentSource).toContain("'min-h-[56vh] px-6 py-5 text-[15px] leading-8'");
    expect(documentSource).toContain('Schwebende Leiste');
    expect(documentSource).toContain('floatingToolbarEnabled');
    expect(modulesFormSource).toContain('name="subsumtionFloatingToolbarDefault"');
    expect(modulesFormSource).toContain('Die feste Leiste bleibt immer sichtbar');
  });

  it('zeichnet beide Formatleisten semantisch aus und macht Zustände hörbar', () => {
    expect(toolbarSource).toContain('role="toolbar"');
    expect(toolbarSource).toContain(
      "bordered ? 'Text formatieren' : 'Schwebende Textformatierung'",
    );
    expect(toolbarSource).toContain('aria-pressed={active === undefined ? undefined : active}');
    expect(toolbarSource).toContain('aria-label={ariaLabel ?? title}');
    expect(toolbarSource).toContain('handleToolbarKeyDown');
    expect(toolbarSource).toContain('aria-hidden="true"');
  });
});
