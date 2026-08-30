import { BLOCK_SIZE, type ClientGridItem } from '@/server/settings/client-layout-shared';
import { adjustGridItem, type GridGeometry } from '@/components/ui/grid-layout-geometry';

export function adjustClientLayoutItem(
  items: readonly ClientGridItem[],
  id: string,
  geometry: GridGeometry,
) {
  return adjustGridItem(items, id, geometry, (item) => BLOCK_SIZE[item.id], 'Block');
}
