'use client';

import { DEFAULT_SIZE, WIDGET_BY_TYPE, type LayoutWidget } from '@/server/dashboard/widgets';
import { GridLayoutControls } from '@/components/ui/grid-layout-controls';
import type { GridGeometry } from '@/components/ui/grid-layout-geometry';

export function DashboardLayoutControls({
  widgets,
  disabled,
  onApply,
  onRemove,
}: {
  widgets: LayoutWidget[];
  disabled: boolean;
  onApply: (id: string, geometry: GridGeometry) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <GridLayoutControls
      widgets={widgets.map((widget) => ({
        ...widget,
        label: WIDGET_BY_TYPE[widget.type].label,
        minW: DEFAULT_SIZE[widget.type].minW,
        minH: DEFAULT_SIZE[widget.type].minH,
      }))}
      itemKind="Widget"
      disabled={disabled}
      onApply={onApply}
      onRemove={onRemove}
    />
  );
}
