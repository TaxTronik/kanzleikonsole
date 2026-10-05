'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { GridLayout, useContainerWidth, type Layout, type LayoutItem } from 'react-grid-layout';
import { X } from 'lucide-react';
import { DEFAULT_SIZE, WIDGET_BY_TYPE, type LayoutWidget } from '@/server/dashboard/widgets';
import {
  DASHBOARD_COLUMNS,
  DASHBOARD_MAX_HEIGHT,
  dashboardGeometryDescription,
} from './dashboard-layout-adjustment';
import { WidgetLoading } from './dashboard-view-grid';
import '@/components/ui/grid-layout-edit.css';

/**
 * Bearbeitungsmodus des Dashboards (Drag/Resize mit react-grid-layout).
 *
 * dashboard-grid.tsx lädt dieses Modul per `next/dynamic` erst, wenn
 * „Anpassen" aktiv wird — samt RGL und dessen CSS. Layout-Zustand, Speichern
 * und Undo bleiben in DashboardGrid; der Editor meldet nur Änderungen.
 */
export function DashboardGridEditor({
  widgets,
  renderById,
  onLayoutChange,
  onRemove,
}: {
  widgets: readonly LayoutWidget[];
  renderById: ReadonlyMap<string, ReactNode>;
  onLayoutChange: (next: Layout) => void;
  onRemove: (id: string) => void;
}) {
  // settled=false beim ersten Paint → das Raster bleibt per Inline-Style
  // `visibility:hidden` UNSICHTBAR (Layout-Dimensionen bleiben erhalten, die
  // Breitenmessung stimmt also weiter) und die CSS-Klasse unterdrückt zusätzlich
  // die Item-Transition. RGL rendert zuerst mit angenommenen 1280px; so
  // „fahren" die Widgets nicht von links aus, sondern erscheinen nach zwei
  // Frames (Position committet) sofort an ihrer Position. Der Inline-Style ist
  // unabhängig davon, wann das Editor-CSS (mit dem Chunk nachgeladen) ankommt.
  // Danach auf true → Drag/Resize animieren wieder normal. Die Leseansicht
  // braucht das alles nicht mehr: sie ist ein statisches CSS-Grid.
  const [settled, setSettled] = useState(false);
  const { width, containerRef, mounted } = useContainerWidth();

  useEffect(() => {
    if (!mounted) return;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setSettled(true)));
    return () => cancelAnimationFrame(id);
  }, [mounted]);

  const rglLayout: LayoutItem[] = widgets.map((w) => {
    const def = DEFAULT_SIZE[w.type];
    return {
      i: w.id,
      x: w.x,
      y: w.y,
      w: w.w,
      h: w.h,
      minW: def?.minW ?? 2,
      minH: def?.minH ?? 2,
      maxW: DASHBOARD_COLUMNS,
      maxH: DASHBOARD_MAX_HEIGHT,
    };
  });

  return (
    <>
      {width < 640 && (
        <p className="text-sm text-secondary">
          Bei wenig Platz wird die Vorschau untereinander angezeigt. Position und Größe lassen sich
          oben ändern; das gespeicherte Raster wird durch diese Vorschau nicht verändert.
        </p>
      )}

      <div
        ref={containerRef}
        className={'dashboard-edit relative' + (settled ? '' : ' dashboard-grid-initial')}
        style={settled ? undefined : { visibility: 'hidden' }}
      >
        {mounted && width < 640 ? (
          <div className="space-y-4">
            {[...widgets]
              .sort((a, b) => a.y - b.y || a.x - b.x)
              .map((widget) => (
                <section
                  key={widget.id}
                  aria-label={WIDGET_BY_TYPE[widget.type].label}
                  className="min-w-0"
                >
                  <p className="mb-2 text-sm text-secondary">
                    {WIDGET_BY_TYPE[widget.type].label}: {dashboardGeometryDescription(widget)}
                  </p>
                  <div className="widget-shell min-w-0">
                    {renderById.get(widget.id) ?? (
                      <div className="card p-4 text-sm text-muted">Widget wird geladen …</div>
                    )}
                  </div>
                </section>
              ))}
          </div>
        ) : (
          mounted && (
            <GridLayout
              width={width}
              layout={rglLayout}
              gridConfig={{ cols: 12, rowHeight: 30, margin: [16, 16], containerPadding: [0, 0] }}
              dragConfig={{ enabled: true, cancel: '.widget-remove' }}
              resizeConfig={{
                enabled: true,
                handles: ['se', 'sw', 'ne', 'nw', 'e', 'w', 's', 'n'],
              }}
              onLayoutChange={onLayoutChange}
            >
              {widgets.map((w) => (
                <div key={w.id} className="relative ring-2 ring-brand-300 rounded-xl">
                  <button
                    type="button"
                    onClick={() => onRemove(w.id)}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="widget-remove absolute -top-2 -right-2 z-10 bg-surface border border-default rounded-full p-1 shadow-sm text-disabled hover:text-red-700"
                    title="Widget entfernen"
                    aria-label={`Widget entfernen: ${WIDGET_BY_TYPE[w.type].label}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                  <div className="h-full widget-shell">
                    {renderById.get(w.id) ?? <WidgetLoading />}
                  </div>
                </div>
              ))}
            </GridLayout>
          )
        )}
      </div>
    </>
  );
}
