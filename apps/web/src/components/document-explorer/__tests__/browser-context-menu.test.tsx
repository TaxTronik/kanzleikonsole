// @vitest-environment jsdom
// Rechtsklick-Menü der Browser-Variante (K-04): „Als ZIP laden“ startet den
// Download über die feste Route aus den IDs des Ordners. Das Menü nimmt keine
// URL mehr entgegen (Scanner-Befund: XSS über window.location.href).
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/components/document-browser-utils';
import type { DocumentOps } from '../ops';
import { BrowserContextMenu, type BrowserContextMenuActions } from '../browser-context-menu';

const download = vi.hoisted(() => vi.fn());
vi.mock('../browser-operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../browser-operations')>()),
  startDocumentsDownload: download,
}));

function actions(): BrowserContextMenuActions {
  return { close: vi.fn(), openMove: vi.fn(), deleteFolder: vi.fn(), softDelete: vi.fn() };
}

const folder: Entry = {
  kind: 'folder',
  id: 'folder-1',
  name: 'Belege',
  href: '/staff/documents?folder=folder-1',
  icon: 'folder',
};

describe('BrowserContextMenu', () => {
  it('lädt einen Ordner über die feste Download-Route und schließt das Menü', () => {
    const menuActions = actions();
    render(
      <BrowserContextMenu
        menu={{ x: 0, y: 0, e: folder }}
        ops={{ router: { push: vi.fn() } } as unknown as DocumentOps}
        actions={menuActions}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Als ZIP laden' }));

    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith([], ['folder-1']);
    expect(menuActions.close).toHaveBeenCalledTimes(1);
  });
});
