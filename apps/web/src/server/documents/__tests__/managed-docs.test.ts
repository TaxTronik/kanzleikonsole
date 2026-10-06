import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
import {
  MANAGED_DOC_SELECT,
  documentTier,
  toManagedDoc,
  type ManagedDocRow,
} from '../managed-docs';

const ROW: ManagedDocRow = {
  id: 'doc-1',
  title: 'Rechnung 2026-0001',
  mimeType: 'application/pdf',
  classification: 'GOBD_INVOICE',
  documentTypeId: null,
  documentType: null,
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
  folderId: 'folder-1',
  deletedAt: null,
  sharedWithClientAt: new Date('2026-09-02T10:00:00.000Z'),
  versions: [{ sizeBytes: 2048n }],
};

describe('ein Dokument-DTO für beide Explorer-Varianten', () => {
  it('leitet die Schutzstufe aus dem Typ, sonst aus der Klassifikation ab', () => {
    expect(documentTier('GENERAL', 'GOBD')).toBe('GOBD');
    expect(documentTier('GOBD_TAX', null)).toBe('GOBD');
    expect(documentTier('GOBD_CONTRACT', undefined)).toBe('GOBD');
    expect(documentTier('GWG_EVIDENCE', null)).toBe('GWG');
    expect(documentTier('GENERAL', null)).toBe('NONE');
  });

  it('bildet die Dokumentzeile vollständig ab', () => {
    expect(toManagedDoc(ROW)).toEqual({
      id: 'doc-1',
      title: 'Rechnung 2026-0001',
      mimeType: 'application/pdf',
      classification: 'GOBD_INVOICE',
      typeName: '',
      typeId: null,
      tier: 'GOBD',
      sizeBytes: 2048,
      createdAt: '2026-09-01T10:00:00.000Z',
      folderId: 'folder-1',
      deletedAt: null,
      shared: true,
    });
    expect(MANAGED_DOC_SELECT.mimeType).toBe(true);
  });

  it('wird von /staff/documents, Mandanten-Tab und Aktenregal genutzt (kein zweiter Tier-Mapper)', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const documentsPage = read('../../../app/staff/(protected)/documents/page.tsx');
    const clientLoader = read('../../../app/staff/(protected)/clients/[id]/_data.ts');
    expect(documentsPage).toContain('select: MANAGED_DOC_SELECT');
    expect(documentsPage).toContain("({ kind: 'file', ...toManagedDoc(d) })");
    expect(documentsPage).not.toContain('GWG_EVIDENCE');
    expect(clientLoader).toContain('rows.map(toManagedDoc)');
    expect(read('../../../components/document-explorer/types.ts')).not.toContain(
      'export interface ManagedDoc',
    );
  });
});
