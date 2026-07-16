import { describe, expect, it, vi } from 'vitest';

vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));

import * as layout from '../client-layout';
import * as shared from '../client-layout-shared';
import type { ClientBlockKey, ClientGridItem, ClientLayoutConfig } from '../client-layout';

describe('Client-Layout Shared-Re-Exports', () => {
  it('stellt alle Konstanten aus genau einer Quelle bereit', () => {
    expect(layout.ALL_CLIENT_BLOCKS).toBe(shared.ALL_CLIENT_BLOCKS);
    expect(layout.CLIENT_BLOCK_LABELS).toBe(shared.CLIENT_BLOCK_LABELS);
    expect(layout.BLOCK_SIZE).toBe(shared.BLOCK_SIZE);
    expect(layout.DEFAULT_CLIENT_LAYOUT).toBe(shared.DEFAULT_CLIENT_LAYOUT);
  });

  it('re-exportiert den öffentlichen Typvertrag', () => {
    const key: ClientBlockKey = 'contacts';
    const item: ClientGridItem = { id: key, x: 0, y: 0, w: 12, h: 6 };
    const config: ClientLayoutConfig = { items: [item] };

    expect(config).toEqual({ items: [item] });
  });
});
