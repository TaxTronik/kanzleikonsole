import { DEFAULT_SIZE, type LayoutWidget } from '@/server/dashboard/widgets';
import { adjustGridItem, type GridGeometry } from '@/components/ui/grid-layout-geometry';

export {
  GRID_COLUMNS as DASHBOARD_COLUMNS,
  GRID_MAX_Y as DASHBOARD_MAX_Y,
  GRID_MAX_HEIGHT as DASHBOARD_MAX_HEIGHT,
  gridGeometryDescription as dashboardGeometryDescription,
} from '@/components/ui/grid-layout-geometry';
export type { GridGeometry as DashboardGeometry } from '@/components/ui/grid-layout-geometry';

export function adjustDashboardWidget(
  widgets: readonly LayoutWidget[],
  id: string,
  geometry: GridGeometry,
) {
  const result = adjustGridItem(widgets, id, geometry, (widget) => DEFAULT_SIZE[widget.type]);
  return result.ok ? { ok: true as const, widgets: result.items, widget: result.item } : result;
}
