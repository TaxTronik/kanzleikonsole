'use client';

import { useState, useRef, useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
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

// Erste-passierende freie Position auf dem 12-Spalten-Grid (First-Fit), statt
// neue Widgets stur unten links anzuhängen (x:0/y:maxY). Nutzt bestehenden
// Freiraum neben anderen Widgets und hält das Dashboard kompakt — löst das
// „alles untereinander"-Problem.
function findFreeSlot(
  existing: { x: number; y: number; w: number; h: number }[],
  w: number,
  h: number,
  cols = 12,
): { x: number; y: number } {
  const occupied = new Set<string>();
  for (const item of existing) {
    for (let ix = item.x; ix < item.x + item.w; ix++) {
      for (let iy = item.y; iy < item.y + item.h; iy++) {
        occupied.add(`${ix},${iy}`);
      }
    }
  }
  for (let y = 0; y < 500; y++) {
    for (let x = 0; x <= cols - w; x++) {
      let fits = true;
      for (let ix = x; ix < x + w; ix++) {
        for (let iy = y; iy < y + h; iy++) {
          if (occupied.has(`${ix},${iy}`)) { fits = false; break; }
        }
        if (!fits) break;
      }
      if (fits) return { x, y };
    }
  }
  const maxY = existing.reduce((acc, item) => Math.max(acc, item.y + item.h), 0);
  return { x: 0, y: maxY };
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
  const router = useRouter();
  const [editMode, setEditMode] = useState(false);
  const [widgets, setWidgets] = useState<LayoutWidget[]>(initialLayout.widgets);
  // Synchroner Spiegel des Widget-States: Click-Handler lesen die aktuellste
  // Liste auch bei schnellen Mehrfach-Klicks (vor dem nächsten Render), ohne
  // Seitenwirkungen in setWidgets-Updatern absetzen zu müssen. Fixt das
  // „weiterhin als hinzufügbar"-Verhalten bei rapid Adds.
  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;
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
    // Gegen veraltete Closures: gegen den synchronen Ref prüfen, nicht gegen
    // den Render-Snapshot `widgets` (sonst verschwinden Widgets bei schnellen
    // Mehrfach-Klicks und tauchen wieder als hinzufügbar auf).
    const current = widgetsRef.current;
    if (current.some((w) => w.type === type)) return;
    const def = DEFAULT_SIZE[type];
    const pos = findFreeSlot(current, def.w, def.h);
    const next: LayoutWidget[] = [
      ...current,
      { id: uid(), type, x: pos.x, y: pos.y, w: def.w, h: def.h },
    ];
    widgetsRef.current = next;
    setWidgets(next);
    // Widgets sind server-gerendert — sofort speichern + Server neu laden,
    // damit der neue Widget-Knoten ohne manuellen Reload an der gefundenen
    // Position erscheint (vorher tauchte er erst nach Reload auf).
    void saveDashboardLayoutAction({ version: 2, widgets: next })
      .then((r) => {
        if (!r.ok) setError(r.error ?? 'Fehler beim Speichern.');
        router.refresh();
      })
      .catch(() => setError('Fehler beim Speichern — bitte erneut versuchen.'));
  }

  function remove(id: string) {
    const current = widgetsRef.current;
    const next = current.filter((w) => w.id !== id);
    widgetsRef.current = next;
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
