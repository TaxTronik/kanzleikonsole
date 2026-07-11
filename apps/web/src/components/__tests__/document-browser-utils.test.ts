import { describe, expect, it } from 'vitest';
import { TIER_BADGE, descendants, fmtBytes } from '../document-browser-utils';

describe('document-browser-utils', () => {
  it('formats byte sizes with stable units', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
    expect(fmtBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });

  it('does not claim a blanket ten-year GoBD retention period', () => {
    expect(TIER_BADGE).toEqual({ GWG: 'GwG·5J+Prüfung', GOBD: 'GoBD·6/8/10J' });
  });

  it('collects descendants including the root folder', () => {
    const result = descendants(
      [
        { id: 'root', name: 'Root', parentId: null },
        { id: 'a', name: 'A', parentId: 'root' },
        { id: 'b', name: 'B', parentId: 'a' },
        { id: 'other', name: 'Other', parentId: null },
      ],
      'root',
    );

    expect(result).toEqual(new Set(['root', 'a', 'b']));
  });
});
