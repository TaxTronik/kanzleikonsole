import { describe, expect, it } from 'vitest';
import { buildFolderDocumentCounts } from '../document-explorer-performance';

describe('DocumentExplorer-Ordnerzaehler', () => {
  it('aggregiert Dokumente aus Unterordnern fuer alle Vorfahren', () => {
    const counts = buildFolderDocumentCounts(
      [
        { id: 'root', parentId: null },
        { id: 'child', parentId: 'root' },
        { id: 'grandchild', parentId: 'child' },
      ],
      [{ folderId: 'root' }, { folderId: 'child' }, { folderId: 'grandchild' }, { folderId: null }],
    );

    expect(counts.byId.get('root')).toBe(3);
    expect(counts.byId.get('child')).toBe(2);
    expect(counts.byId.get('grandchild')).toBe(1);
    expect(counts.withoutFolder).toBe(1);
  });

  it('bricht bei einer beschaedigten zyklischen Ordnerstruktur sicher ab', () => {
    const counts = buildFolderDocumentCounts(
      [
        { id: 'a', parentId: 'b' },
        { id: 'b', parentId: 'a' },
      ],
      [{ folderId: 'a' }],
    );

    expect(counts.byId.get('a')).toBe(1);
    expect(counts.byId.get('b')).toBe(1);
  });
});
