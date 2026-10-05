import type { CSSProperties, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import type { LayoutWidget } from '@/server/dashboard/widgets';
import { compactDashboardWidgets } from './dashboard-layout-adjustment';

/**
 * Leseansicht des Dashboards als CSS-Grid. Wird mit dem Server-HTML vollständig
 * gerendert und ist ohne JavaScript sichtbar: kein `visibility: hidden` bis zur
 * Hydration, kein react-grid-layout (das lädt erst der Editor).
 *
 * Position und Größe stammen aus dem gespeicherten Layout, kompaktiert wie im
 * Editor, und gehen als CSS-Variablen an das Item; die Breakpoints (einspaltig
 * unter 640px Containerbreite) stehen in globals.css (`.dashboard-view*`). Die
 * DOM-Reihenfolge folgt Zeile, dann Spalte — so stimmen Tab- und Lesereihenfolge
 * auch in der gestapelten Ansicht.
 */
export function DashboardViewGrid({
  widgets,
  renderById,
}: {
  widgets: readonly LayoutWidget[];
  renderById: ReadonlyMap<string, ReactNode>;
}) {
  const ordered = compactDashboardWidgets(widgets).sort((a, b) => a.y - b.y || a.x - b.x);
  return (
    <div className="dashboard-view">
      <div className="dashboard-view-grid">
        {ordered.map((widget) => (
          <div
            key={widget.id}
            className="dashboard-view-item"
            style={
              {
                '--dg-col': `${widget.x + 1} / span ${widget.w}`,
                '--dg-row': `${widget.y + 1} / span ${widget.h}`,
                '--dg-h': widget.h,
              } as CSSProperties
            }
          >
            <div className="widget-shell h-full">
              {renderById.get(widget.id) ?? <WidgetLoading />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function WidgetLoading() {
  return (
    <div className="card flex h-full items-center justify-center gap-2 text-sm text-muted">
      <Loader2 className="h-4 w-4 animate-spin" /> Widget wird geladen …
    </div>
  );
}
