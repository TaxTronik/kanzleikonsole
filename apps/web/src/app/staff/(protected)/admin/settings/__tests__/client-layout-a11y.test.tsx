import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  BLOCK_SIZE,
  CLIENT_BLOCK_LABELS,
  DEFAULT_CLIENT_LAYOUT,
  type ClientGridItem,
} from '@/server/settings/client-layout-shared';
import { GridLayoutControls } from '@/components/ui/grid-layout-controls';
import { adjustClientLayoutItem } from '../client-layout-adjustment';

describe('ACP-Mandantenlayout: Tastatur- und Einzelklick-Alternative', () => {
  it('nutzt Block-Minima und erhält IDs, Reihenfolge und unveränderte Eingabedaten', () => {
    const original = Object.freeze(
      DEFAULT_CLIENT_LAYOUT.items.map((item) => Object.freeze({ ...item })),
    );
    const result = adjustClientLayoutItem(original, 'contacts', { x: 6, y: 0, w: 6, h: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item).toEqual({ id: 'contacts', x: 6, y: 0, w: 6, h: 4 });
    expect(result.items.map(({ id }) => id)).toEqual(original.map(({ id }) => id));
    expect(original).toEqual(DEFAULT_CLIENT_LAYOUT.items);
  });

  it.each([
    { x: 0, y: 0, w: 5, h: 6 },
    { x: 0, y: 0, w: 6, h: 3 },
    { x: 7, y: 0, w: 6, h: 4 },
    { x: 0, y: 201, w: 6, h: 4 },
    { x: 0, y: 0, w: 6, h: 41 },
    { x: 0.5, y: 0, w: 6, h: 4 },
  ])('verwirft unzulässige Ansprechpartner-Geometrie: %j', (geometry) => {
    expect(adjustClientLayoutItem(DEFAULT_CLIENT_LAYOUT.items, 'contacts', geometry).ok).toBe(
      false,
    );
  });

  it('meldet einen entfernten Block, ohne ein Ersatzobjekt anzulegen', () => {
    expect(adjustClientLayoutItem([], 'contacts', { x: 0, y: 0, w: 6, h: 4 }).ok).toBe(false);
  });

  it('beschriftet alle Block-Bedienelemente und erklärt die bestehende Mindestanzahl', () => {
    const item: ClientGridItem = { id: 'contacts', x: 0, y: 0, w: 12, h: 6 };
    const html = renderToStaticMarkup(
      <GridLayoutControls
        widgets={[{ ...item, label: CLIENT_BLOCK_LABELS[item.id], ...BLOCK_SIZE[item.id] }]}
        itemKind="Block"
        disabled={false}
        removeDisabled
        onApply={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(html).toContain('Block anpassen');
    expect(html).toContain('aria-label="Ansprechpartner: Position und Größe"');
    expect(html).toMatch(/<form[^>]*data-settings-no-track="true"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Block entfernen: Ansprechpartner<\/button>/);
    expect(html).toContain('Mindestens ein Block muss erhalten bleiben.');
    expect(html).toContain('name="width"');
    expect(html).toContain('min="6" max="12"');
    expect(html).toContain('min="4" max="40"');
  });

  it('bindet Änderungen an den vorhandenen Speicherweg und schützt Fokus/Live-Rückmeldung', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'client-layout-form.tsx'),
      'utf8',
    );
    expect(source).toContain('onApply={applyGeometry}');
    expect(source).toContain('adjustClientLayoutItem(itemsRef.current, id, geometry)');
    expect(source).toContain('saveClientLayoutAction({ items: next })');
    expect(source).toMatch(/saveQueue\.current\s*\.then\(async \(\) =>/);
    expect(source).toContain('role="status"');
    expect(source).toContain('role="alert"');
    expect(source).toContain('editButtonRef.current?.focus()');
    expect(source).toContain('if (current.length <= 1)');
    expect(source).toContain('await saveQueue.current');
    expect(source).not.toContain('useAccessibleDisplay');
  });
});
