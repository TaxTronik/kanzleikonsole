// @vitest-environment jsdom
// Beide Explorer-Varianten löschen nur über den gemeinsamen Lösch-Dialog (mit
// Grund). Render- und Klicktest in jsdom (B-08, Welle 15); ersetzt die
// Quelltextprüfung aus delete-dialog.test.tsx. Die früheren Einzel-Löschwege
// (softDeleteDocumentAction, DeleteDocModal) existieren nicht mehr; ein Import
// fiele bereits in der Typprüfung auf.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry, ManagedDoc } from '../types';

const h = vi.hoisted(() => ({
  dialog: vi.fn(),
  softDeleteDocuments: vi.fn(),
  router: { refresh: vi.fn(), push: vi.fn(), replace: vi.fn() },
}));

vi.mock('next/navigation', () => ({ useRouter: () => h.router }));
vi.mock('@/app/staff/(protected)/documents/actions', () => ({
  softDeleteDocumentsAction: h.softDeleteDocuments,
  restoreDocumentAction: vi.fn(),
  setDocumentShareAction: vi.fn(),
  setDocumentsShareAction: vi.fn(),
  retagDocumentsAction: vi.fn(),
}));
vi.mock('@/app/staff/(protected)/documents/folder-actions', () => ({
  createFolderAction: vi.fn(),
  renameFolderAction: vi.fn(),
  deleteFolderAction: vi.fn(),
  moveDocumentItemsAction: vi.fn(),
}));
vi.mock('@/components/document-preview', () => ({ DocumentPreviewModal: () => null }));
vi.mock('@/components/document-dialogs', () => ({
  MoveDialog: () => null,
  RetagDialog: () => null,
  MoveTargetDialog: () => null,
}));
vi.mock('@/components/document-upload-button', () => ({ DocumentUploadButton: () => null }));
vi.mock('../delete-dialog', async (importOriginal) => {
  const original = await importOriginal<typeof import('../delete-dialog')>();
  return {
    ...original,
    DeleteDocumentsDialog: (props: Parameters<typeof original.DeleteDocumentsDialog>[0]) => {
      h.dialog(props);
      return original.DeleteDocumentsDialog(props);
    },
  };
});

import { DocumentExplorer } from '..';

const DOC: ManagedDoc = {
  id: 'doc-1',
  title: 'Rechnung 2026-0001',
  mimeType: 'application/pdf',
  classification: 'GOBD_INVOICE',
  typeName: '',
  typeId: null,
  tier: 'GOBD',
  sizeBytes: 2048,
  createdAt: '2026-09-01T10:00:00.000Z',
  folderId: null,
  deletedAt: null,
  shared: false,
};

function deletedIds(): string[] {
  const props = h.dialog.mock.calls.at(-1)![0] as { docs: { id: string }[] };
  return props.docs.map((doc) => doc.id);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Explorer: Löschen nur über den gemeinsamen Dialog', () => {
  it('Browser-Variante öffnet den Dialog aus der Zeile', async () => {
    render(
      <DocumentExplorer
        variant="browser"
        crumbs={[{ label: 'Dokumente', href: '/staff/documents' }]}
        entries={[{ kind: 'file', ...DOC } as Entry]}
        scope={{ clientId: null, typeParam: 'INTERNAL' }}
        folders={[]}
        currentFolderId={null}
        deleted={false}
        q=""
      />,
    );
    expect(h.dialog).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTitle('Löschen'));
    });
    expect(deletedIds()).toEqual(['doc-1']);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(h.softDeleteDocuments).not.toHaveBeenCalled();
  });

  it('Embedded-Variante öffnet denselben Dialog', async () => {
    render(
      <DocumentExplorer
        variant="embedded"
        clientId="client-1"
        folders={[]}
        documents={[DOC]}
        scopeLabel="Muster GmbH"
      />,
    );
    expect(h.dialog).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTitle('Löschen'));
    });
    expect(deletedIds()).toEqual(['doc-1']);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(h.softDeleteDocuments).not.toHaveBeenCalled();
  });
});
