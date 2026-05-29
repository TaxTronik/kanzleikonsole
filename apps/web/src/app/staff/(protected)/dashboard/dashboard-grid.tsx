'use client';

import { useState, useRef, useEffect, type ReactNode } from 'react';
import {
  GridLayout,
  useContainerWidth,
  type Layout,
  type LayoutItem,
} from 'react-grid-layout';
import { Plus, Settings2, RotateCcw, Check, X } from 'lucide-react';
import {
  WIDGETS,
  WIDGET_BY_TYPE,
  DEFAULT_SIZE,
  type DashboardLayout,
  type LayoutWidget,
  type WidgetType,
} from '@/server/dashboard/widgets';
import { saveDashboardLayoutAction, resetDashboardLayoutAction } from './actions';

// IDs für neu hinzugefügte Widgets. Wird nur in Click-Handlern aufgerufen
// (kein Render-Pfad → keine Hydration-Differenz möglich). crypto.randomUUID
// statt Math.random — sauber, kollisionsfrei, ohne Workaround.
function uid(): string {
  return 'w-' + crypto.randomUUID();
}

interface RenderedWidget {
  widget: LayoutWidget;
  node: ReactNode;
}

export function DashboardGrid({
  initialLayout,
  initialRendered,
}: {
  initialLayout: DashboardLayout;
  initialRendered: RenderedWidget[];
}) {
  const [editMode, setEditMode] = useState(false);
  const [widgets, setWidgets] = useState<LayoutWidget[]>(initialLayout.widgets);
  const [error, setError] = useState<string | null>(null);
  // settled=false beim ersten Paint → der Grid bleibt per Inline-Style
  // `visibility:hidden` UNSICHTBAR (Layout-Dimensionen bleiben erhalten, die
  // Breitenmessung stimmt also weiter) und die CSS-Klasse unterdrückt zusätzlich
  // die Item-Transition. So „fahren" die Widgets nicht von links aus, sondern
  // erscheinen nach zwei Frames (Position committet) sofort an ihrer Position.
  // Der Inline-Style ist timing-unabhängig von der CSS-Injektion (in Turbopack-
  // Dev wird CSS per JS injiziert → bei Hard-Reload kann RGLs eigenes
  // `transition`-CSS sonst einen Frame vor der Suppression-Klasse ankommen).
  // Danach auf true → Drag/Resize animieren wieder normal.
  const [settled, setSettled] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { width, containerRef, mounted } = useContainerWidth();

  const renderById = new Map(initialRendered.map((r) => [r.widget.id, r.node]));

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setSettled(true)));
    return () => cancelAnimationFrame(id);
  }, [mounted]);

  function persist(next: LayoutWidget[]) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const r = await saveDashboardLayoutAction({ version: 2, widgets: next });
      if (!r.ok) setError(r.error ?? 'Fehler beim Speichern.');
    }, 600);
  }

  function onLayoutChange(next: Layout) {
    setWidgets((current) => {
      const byId = new Map(current.map((w) => [w.id, w]));
      const updated: LayoutWidget[] = [];
      for (const l of next) {
        const w = byId.get(l.i);
        if (!w) continue;
        updated.push({ ...w, x: l.x, y: l.y, w: l.w, h: l.h });
      }
      // Nur persist, wenn sich tatsächlich etwas geändert hat
      const same =
        updated.length === current.length &&
        updated.every((u, i) => {
          const c = current[i];
          return c && c.id === u.id && c.x === u.x && c.y === u.y && c.w === u.w && c.h === u.h;
        });
      if (!same && editMode) persist(updated);
      return updated;
    });
  }

  function add(type: WidgetType) {
    // Doppelt-Klick-Schutz: gleichen Typ nicht ein zweites Mal einfügen
    if (widgets.some((w) => w.type === type)) return;
    const def = DEFAULT_SIZE[type];
    const maxY = widgets.reduce((acc, w) => Math.max(acc, w.y + w.h), 0);
    const next: LayoutWidget[] = [
      ...widgets,
      { id: uid(), type, x: 0, y: maxY, w: def.w, h: def.h },
    ];
    setWidgets(next);
    persist(next);
  }

  function remove(id: string) {
    const next = widgets.filter((w) => w.id !== id);
    setWidgets(next);
    persist(next);
  }

  async function reset() {
    if (!confirm('Standard-Layout wiederherstellen?')) return;
    const r = await resetDashboardLayoutAction();
    if (!r.ok) setError(r.error ?? 'Fehler.');
    else window.location.reload();
  }

  const visible = widgets.filter((w) => renderById.has(w.id));
  const rglLayout: LayoutItem[] = visible.map((w) => {
    const def = DEFAULT_SIZE[w.type];
    return {
      i: w.id,
      x: w.x, y: w.y, w: w.w, h: w.h,
      minW: def?.minW ?? 2, minH: def?.minH ?? 2,
    };
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        {editMode && (
          <button
            type="button"
            onClick={reset}
            className="btn-secondary text-xs"
            title="Auf Standard zurücksetzen"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Standard
          </button>
        )}
        <button
          type="button"
          onClick={() => setEditMode((v) => !v)}
          className={editMode ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
        >
          {editMode ? <Check className="h-3.5 w-3.5" /> : <Settings2 className="h-3.5 w-3.5" />}
          {editMode ? 'Fertig' : 'Anpassen'}
        </button>
      </div>

      {error && <div className="alert-error-sm">{error}</div>}

      {editMode && <AddWidgetBar widgets={widgets} onAdd={add} />}

      <div
        ref={containerRef}
        className={
          (editMode ? 'dashboard-edit relative' : 'relative') + (settled ? '' : ' dashboard-grid-initial')
        }
        style={settled ? undefined : { visibility: 'hidden' }}
      >
        {mounted && (
          <GridLayout
            width={width}
            layout={rglLayout}
            gridConfig={{ cols: 12, rowHeight: 30, margin: [16, 16], containerPadding: [0, 0] }}
            dragConfig={{ enabled: editMode, cancel: '.widget-remove' }}
            resizeConfig={{ enabled: editMode, handles: ['se', 'sw', 'ne', 'nw', 'e', 'w', 's', 'n'] }}
            onLayoutChange={onLayoutChange}
          >
            {visible.map((w) => (
              <div
                key={w.id}
                className={
                  'relative ' + (editMode ? 'ring-2 ring-brand-300 rounded-xl' : '')
                }
              >
                {editMode && (
                  <button
                    type="button"
                    onClick={() => remove(w.id)}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="widget-remove absolute -top-2 -right-2 z-10 bg-surface border border-default rounded-full p-1 shadow-sm text-disabled hover:text-red-700"
                    title="Widget entfernen"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
                <div className="h-full widget-shell">{renderById.get(w.id)}</div>
              </div>
            ))}
          </GridLayout>
        )}
      </div>

      {visible.length === 0 && (
        <div className="card p-12 text-center text-sm text-muted">
          Kein Widget aktiv. Klicke auf „Anpassen" und füge Widgets hinzu.
        </div>
      )}
    </div>
  );
}

function AddWidgetBar({
  widgets,
  onAdd,
}: {
  widgets: LayoutWidget[];
  onAdd: (t: WidgetType) => void;
}) {
  // Pro Widget-Typ nur einmal auf dem Dashboard — Dopplungen sind nicht
  // sinnvoll und verwirren beim Auto-Reflow.
  const usedTypes = new Set(widgets.map((w) => w.type));
  const available = WIDGETS.filter((w) => !usedTypes.has(w.type));
  return (
    <div className="card p-3">
      <p className="text-xs font-medium text-secondary mb-2">
        Widget hinzufügen
        {available.length === 0 && (
          <span className="ml-2 font-normal text-muted">
            — alle bereits auf dem Dashboard
          </span>
        )}
      </p>
      {available.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {available.map((w) => (
            <button
              key={w.type}
              type="button"
              onClick={() => onAdd(w.type)}
              className="btn-secondary text-xs py-1"
              title={w.description}
            >
              <Plus className="h-3 w-3" />
              {WIDGET_BY_TYPE[w.type]?.label ?? w.type}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
